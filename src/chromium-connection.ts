
import {
    JsmsConnection,
    JsmsDeferred,
    JsmsMessage,
    JsmsQueue,
    JsmsQueueSender,
    JsmsQueueReceiver,
    JsmsTopic,
    JsmsTopicPublisher,
    JsmsTopicSubscriber
} from "jsms";

import { getLogger } from "@log4js-node/log4js-api";


function currentTimeMillis(): number {
    return new Date().getTime();
}

export class ChromiumConnection extends JsmsConnection {
    public static readonly CEF_HANDSHAKE_INIT = "/cef/handshake/init";
    public static readonly CEF_HANDSHAKE_SERVER_READY = "/cef/handshake/server/ready";
    public static readonly CEF_HANDSHAKE_CLIENT_READY = "/cef/handshake/client/ready";
    public static readonly DEFAULT_TIME_TO_LIVE: number = 1000;
    public static readonly DEFAULT_HANDSHAKE_RETRY_COUNT: number = 60;
    public static readonly DEFAULT_HANDSHAKE_RETRY_DELAY: number = 100;

    private readonly logger = getLogger("[CHROMIUM]");
    private responseDeferreds = new Map<string, JsmsDeferred<JsmsMessage>>();
    private currentHandshakeRetries: number = 0;

    /**
     * @param defaultTimeToLive will be used to calculate expiration time when no
     *        custom value is provided to the send function
     * @param maxHandshakeRetries specifies how often the handshake will be retried
     * @param globalNS is only used by unit tests -
     *        in production code you should ignore it and just leave it undefined
     */
    constructor(private defaultTimeToLive: number = ChromiumConnection.DEFAULT_TIME_TO_LIVE,
                private maxHandshakeRetries: number = ChromiumConnection.DEFAULT_HANDSHAKE_RETRY_COUNT,
                private globalNS: any = window) {
        super();

        this.globalNS.onMessage = (json: any) => {
            try {
                this.onMessage(JsmsMessage.fromJSON(json));
            }
            catch (e) {
                this.logger.error(e);
            }
        };
    }

    private onMessage(message: JsmsMessage): void {
        const responseDeferred = this.responseDeferreds.get(message.header.correlationID);
        if (responseDeferred) {
            this.handleResponse(message, responseDeferred);
        }
        else {
            const destination = this.getDestinationFor(message.header.destination);
            const consumer = this.getConsumer(destination);

            consumer.onMessage(message);
        }
    }

    private handleResponse(response: JsmsMessage, responseDeferred: JsmsDeferred<JsmsMessage>): void {
        if (this.logger.isDebugEnabled()) {
            this.logger.debug("Receiving response: \""
                + response.header.destination + "\" ["
                + response.header.correlationID + "]:\n"
                + JSON.stringify(response.body));
        }

        this.responseDeferreds.delete(response.header.correlationID);
        responseDeferred.resolve(response);
    }

    public createQueue(queueName: string): JsmsQueue {
        const queue = new JsmsQueue(queueName);
        this.addQueue(queue, new JsmsQueueSender(this, queue), new JsmsQueueReceiver(queue));
        return queue;
    }

    public createTopic(topicName: string): JsmsTopic {
        const topic = new JsmsTopic(topicName);
        this.addTopic(topic, new JsmsTopicPublisher(topic), new JsmsTopicSubscriber(topic));
        return topic;
    }

    public send(message: JsmsMessage): JsmsDeferred<JsmsMessage> {
        if (typeof this.globalNS.cefQuery !== "function") {
            throw new Error("CEF message router isn't available!");
        }

        if (this.logger.isDebugEnabled()) {
            this.logger.debug("Sending request: \""
                + message.header.destination + "\" ["
                + message.header.correlationID + "]:\n"
                + JSON.stringify(message.body));
        }

        const deferredResponse = new JsmsDeferred<JsmsMessage>();
        this.sendToChromium(message, deferredResponse);
        this.handleExpiration(message, deferredResponse);

        return deferredResponse;
    }

    private sendToChromium(message: JsmsMessage, deferredResponse: JsmsDeferred<JsmsMessage>): void {
        this.responseDeferreds.set(message.header.correlationID, deferredResponse);

        const cefQuery = {
            request: message.toString(),
            persistent: false,
            onSuccess: (response: string) => {
                deferredResponse.resolve(JsmsMessage.fromString(response));
                this.responseDeferreds.delete(message.header.correlationID);
            },
            onFailure: (errorCode: number, errorMessage: string) => {
                this.logger.error("cefQuery call failed for: "
                    + "\ndestination: " + message.header.destination
                    + "\nerror-code: " + errorCode
                    + "\nerror-message: " + errorMessage);

                deferredResponse.reject(errorMessage);
                this.responseDeferreds.delete(message.header.correlationID);
            }
        };

        this.globalNS.cefQuery(cefQuery);
    }

    private handleExpiration(message: JsmsMessage, deferredResponse: JsmsDeferred<JsmsMessage>): void {
        if (message.header.expiration === 0) {
            return;
        }

        let timeToLive = message.header.expiration - currentTimeMillis();
        timeToLive = Math.max(0, timeToLive);

        setTimeout(() => {
            if (this.responseDeferreds.has(message.header.correlationID)) {
                this.responseDeferreds.delete(message.header.correlationID);
                deferredResponse.reject(message.createExpirationMessage());
            }
        }, timeToLive);
    }

    public sendHandshake(): JsmsDeferred<JsmsMessage> {
        this.currentHandshakeRetries = 0;
        const outerDeferred = new JsmsDeferred<JsmsMessage>();

        try {
            this.sendHandshakeInternal(outerDeferred);
        }
        catch (e) {
            outerDeferred.reject(e);
        }

        return outerDeferred;
    }

    private sendHandshakeInternal(outerDeferred: JsmsDeferred<JsmsMessage>): JsmsDeferred<JsmsMessage> {
        this.logger.info("Beginning HANDSHAKE @" + currentTimeMillis() + "...");

        // first pass: check if client receives messages
        const deferred = this.sendHandshakeInit();
        deferred.then(() => {
            // second pass: let the client know that we are able to receive messages
            this.sendServerReady()
                .then(ack => {
                    // client acknowledged - connection successfully established
                    this.resolveHandshake(outerDeferred, ack);
                })
                .catch(reason => {
                    this.retryHandshake(outerDeferred, reason);
                });
        })
        .catch(error => {
            this.retryHandshake(outerDeferred, error);
        });

        return deferred;
    }

    private sendHandshakeInit(): JsmsDeferred<JsmsMessage> {
        const initMessage = JsmsMessage.create(
            ChromiumConnection.CEF_HANDSHAKE_INIT,
            {},
            this.defaultTimeToLive);

        const deferred = this.send(initMessage);
        deferred.catch(() => {
            this.logger.error("HANDSHAKE INIT TIMEOUT: "
                + initMessage.header.correlationID
                + ' @' + currentTimeMillis());
        });

        return deferred;
    }

    private sendServerReady(): JsmsDeferred<JsmsMessage> {
        const serverReadyMessage = JsmsMessage.create(
            ChromiumConnection.CEF_HANDSHAKE_SERVER_READY,
            {},
            this.defaultTimeToLive);

        const deferred = this.send(serverReadyMessage);
        deferred.catch(() => {
            this.logger.error("SERVER READY TIMEOUT: "
                + serverReadyMessage.header.correlationID
                + ' @' + currentTimeMillis());
        });

        return deferred;
    }

    private resolveHandshake(outerDeferred: JsmsDeferred<JsmsMessage>, ack: JsmsMessage): void {
        this.logger.info("HANDSHAKE SUCCESSFUL @" + currentTimeMillis());
        outerDeferred.resolve(ack);
    }

    private retryHandshake(outerDeferred: JsmsDeferred<JsmsMessage>, error: Error): void {
        if (this.currentHandshakeRetries++ < this.maxHandshakeRetries) {
            this.logger.error("HANDSHAKE FAILED, retrying ...");
            setTimeout(() => {
                this.sendHandshakeInternal(outerDeferred);
            }, ChromiumConnection.DEFAULT_HANDSHAKE_RETRY_DELAY);
        }
        else {
            this.logger.error("HANDSHAKE FAILED @" + currentTimeMillis());
            outerDeferred.reject(error);
        }
    }
}
