import { JsmsService, JsmsMessage } from "jsms";
import { ChromiumConnection } from "../src/chromium-connection";
import { getLogger } from "@log4js-node/log4js-api";

const QUEUE_NAME = "/some/destination";
const DEFAULT_TIME_TO_LIVE = 1000;
const DEFAULT_RESPONSE_DELAY = 500;
const expectedRequestBody = {request: "PING"};
const expectedResponseBody = {response: "PONG"};
const expectedErrorMessage = "some error message";

let messageService: JsmsService;
let connection: ChromiumConnection;

// --------------------------------------------------------------------------------------------------------------------

beforeAll(() => {
    getLogger("jsms").level = "debug";
    getLogger("[CHROMIUM]").level = "debug";
});

// --------------------------------------------------------------------------------------------------------------------

beforeEach(() => {
    messageService = new JsmsService();
});

// --------------------------------------------------------------------------------------------------------------------

afterEach(() => {
    messageService.close();
});

// --------------------------------------------------------------------------------------------------------------------

test("rejects if CEF message router isn't available after max retries", async () => {
    const windowWithoutMessageRouter = {};
    connection = new ChromiumConnection(DEFAULT_TIME_TO_LIVE,
        ChromiumConnection.DEFAULT_HANDSHAKE_RETRY_COUNT,
        windowWithoutMessageRouter);

    messageService.createQueue(QUEUE_NAME, connection);

    const deferred = messageService.send(QUEUE_NAME, expectedRequestBody);
    deferred.catch(reason => {
       // handle error here
    });

    await expect(deferred.promise).rejects.toBeDefined();
}, 30000);

// --------------------------------------------------------------------------------------------------------------------

class FakeCefMessageRouter {
    private currentHandshakeInitCount: number = 0;
    private currentHandshakeServerReadyCount: number = 0;

    constructor(private readonly desiredHandshakeInitFailCount: number,
                private readonly desiredHandshakeServerReadyFailCount: number) {}

    public cefQuery(query: any): void {
        const request = JSON.parse(query.request) as JsmsMessage;
        if (request.header.destination
                === ChromiumConnection.CEF_HANDSHAKE_INIT) {
            if (this.currentHandshakeInitCount++ < this.desiredHandshakeInitFailCount) {
                return;
            }

            this.sendClientReady(request);
            return;
        }

        if (request.header.destination
                === ChromiumConnection.CEF_HANDSHAKE_SERVER_READY) {
            if (this.currentHandshakeServerReadyCount++ < this.desiredHandshakeServerReadyFailCount) {
                return;
            }
            this.acknowledgeServerReady(request);
        }
    }

    protected sendClientReady(request: JsmsMessage): void {
        setTimeout(() => {
            const response = JsmsMessage.create(
                ChromiumConnection.CEF_HANDSHAKE_CLIENT_READY,
                {},
                DEFAULT_TIME_TO_LIVE,
                request.header.correlationID);
            this.onMessage(response);
        }, DEFAULT_RESPONSE_DELAY);
    }

    protected acknowledgeServerReady(request: JsmsMessage): void {
        setTimeout(() => {
            this.onMessage(JsmsMessage.createResponse(request));
        }, DEFAULT_RESPONSE_DELAY);
    }

    // This will be overwritten by our Chromium connection
    public onMessage(json: any): void {
        throw new Error("Illegal call");
    }
}

// --------------------------------------------------------------------------------------------------------------------

test("a ChromiumConnection queue receiver can fetch a message even when it's running before the client sends the message", async () => {
    const expectedMessageBody = { test: "foo" };

    const globalNS = new FakeCefMessageRouter(0, 0);
    connection = new ChromiumConnection(DEFAULT_TIME_TO_LIVE,
        ChromiumConnection.DEFAULT_HANDSHAKE_RETRY_COUNT,
        globalNS);

    messageService.createQueue(QUEUE_NAME, connection);

    // given a receiver is present
    const deferredDelivery = messageService.receive(QUEUE_NAME);

    // when a message is sent
    globalNS.onMessage(JsmsMessage.create(QUEUE_NAME, expectedMessageBody));

    /// then the listener should have received the message
    const actualMessage = await deferredDelivery.promise;
    expect(actualMessage.body).toEqual(expectedMessageBody);
});

// --------------------------------------------------------------------------------------------------------------------

test("a ChromiumConnection queue receiver can fetch a message even when it wasn't running when the client sent the message", async () => {
    const expectedMessageBody = { test: "foo" };

    const globalNS = new FakeCefMessageRouter(0, 0);
    connection = new ChromiumConnection(DEFAULT_TIME_TO_LIVE,
        ChromiumConnection.DEFAULT_HANDSHAKE_RETRY_COUNT,
        globalNS);

    messageService.createQueue(QUEUE_NAME, connection);

    // given the message was sent before the receiver is running
    globalNS.onMessage(JsmsMessage.create(QUEUE_NAME, expectedMessageBody));

    // when the message is fetched
    const deferredDelivery = messageService.receive(QUEUE_NAME);

    // then the message should be received
    const actualMessage = await deferredDelivery.promise;
    expect(actualMessage.body).toEqual(expectedMessageBody);
});


// --------------------------------------------------------------------------------------------------------------------

test("a topic message is published to all subscribers of a ChromiumConnection topic exactly once", () => {
    const topicName = "/some/topic";
    const expectedMessageBody = { test: "foo" };
    let receivedCount = 0;

    const globalNS = new FakeCefMessageRouter(0, 0);
    connection = new ChromiumConnection(DEFAULT_TIME_TO_LIVE,
        ChromiumConnection.DEFAULT_HANDSHAKE_RETRY_COUNT,
        globalNS);

    messageService.createTopic(topicName, connection);

    messageService.subscribe(topicName, actualMessage => {
        expect(actualMessage.body).toEqual(expectedMessageBody);
        receivedCount++;
    });

    messageService.subscribe(topicName, actualMessage => {
        expect(actualMessage.body).toEqual(expectedMessageBody);
        receivedCount++;
    });

    // given the message was sent before the receiver is running
    globalNS.onMessage(JsmsMessage.create(topicName, expectedMessageBody));

    expect(receivedCount).toBe(2);
});

// --------------------------------------------------------------------------------------------------------------------

test("a ChromiumConnection catches exceptions inside onMessage callback", async () => {
    let exceptionWasThrown = false;

    const globalNS = new FakeCefMessageRouter(0, 0);
    connection = new ChromiumConnection(DEFAULT_TIME_TO_LIVE,
        ChromiumConnection.DEFAULT_HANDSHAKE_RETRY_COUNT,
        globalNS);

    messageService.createQueue(QUEUE_NAME, connection);

    // when an invalid message string is sent
    try {
        globalNS.onMessage("invalid message string");
    }
    catch (e) {
        exceptionWasThrown = true;
    }

    // then exception should have been caught by the connection
    expect(exceptionWasThrown).toBeFalsy();
});

// --------------------------------------------------------------------------------------------------------------------

class FakeSimpleRespondingCefMessageRouter {
    public cefQuery(query: any): void {
        const actualRequest = JSON.parse(query.request);
        expect(actualRequest.body).toEqual(expectedRequestBody);

        setTimeout(() => {
            const response = JsmsMessage.createResponse(actualRequest, expectedResponseBody, DEFAULT_TIME_TO_LIVE);
            this.onMessage(response);
        }, DEFAULT_RESPONSE_DELAY);
    }

    // This will be overwritten by our Chromium connection
    private onMessage(message: JsmsMessage): void {
        throw new Error("Illegal call");
    }
}

// --------------------------------------------------------------------------------------------------------------------

test("ChromiumConnection supports simple asynchronous request/reply chaining with deferreds", async () => {
    const globalNS = new FakeSimpleRespondingCefMessageRouter();
    connection = new ChromiumConnection(DEFAULT_TIME_TO_LIVE,
        ChromiumConnection.DEFAULT_HANDSHAKE_RETRY_COUNT,
        globalNS);

    messageService.createQueue(QUEUE_NAME, connection);

    const promise = new Promise<void>(resolve => {
        messageService.send(QUEUE_NAME, expectedRequestBody)
            .then(actualResponse => {
                expect(actualResponse.body).toEqual(expectedResponseBody);
                resolve();
            });
    });

    await promise;
});

// --------------------------------------------------------------------------------------------------------------------

test("ChromiumConnection supports immediate client handshake", async () => {

    const globalNS = new FakeCefMessageRouter(0, 0);
    connection = new ChromiumConnection(DEFAULT_TIME_TO_LIVE,
        ChromiumConnection.DEFAULT_HANDSHAKE_RETRY_COUNT,
        globalNS);

    messageService.createQueue(QUEUE_NAME, connection);

    const handshakeDeferred = connection.sendHandshake();
    handshakeDeferred.then(() => {
        // connection established - proper communication is guaranteed now
    });

    await expect(handshakeDeferred.promise).resolves.toBeDefined();
});

// --------------------------------------------------------------------------------------------------------------------

test("ChromiumConnection retries failed handshake inits", async () => {
    const globalNS = new FakeCefMessageRouter(5, 0);
    connection = new ChromiumConnection(DEFAULT_TIME_TO_LIVE,
        ChromiumConnection.DEFAULT_HANDSHAKE_RETRY_COUNT,
        globalNS);
    messageService.createQueue(QUEUE_NAME, connection);

    const handshakeDeferred = connection.sendHandshake();
    handshakeDeferred.then(() => {
        // connection established - proper communication is guaranteed now
    });

    await expect(handshakeDeferred.promise).resolves.toBeDefined();
}, 30000);

// --------------------------------------------------------------------------------------------------------------------

test("ChromiumConnection retries failed acknowledges of server-ready messages", async () => {
    const globalNS = new FakeCefMessageRouter(0, 5);
    connection = new ChromiumConnection(DEFAULT_TIME_TO_LIVE,
        ChromiumConnection.DEFAULT_HANDSHAKE_RETRY_COUNT,
        globalNS);
    messageService.createQueue(QUEUE_NAME, connection);

    const handshakeDeferred = connection.sendHandshake();
    handshakeDeferred.then(() => {
        // connection established - proper communication is guaranteed now
    });

    await expect(handshakeDeferred.promise).resolves.toBeDefined();
}, 30000);

// --------------------------------------------------------------------------------------------------------------------

test("ChromiumConnection retries failed handshake inits and failed acknowledges of server-ready messages", async () => {
    const globalNS = new FakeCefMessageRouter(5, 5);
    connection = new ChromiumConnection(DEFAULT_TIME_TO_LIVE,
        ChromiumConnection.DEFAULT_HANDSHAKE_RETRY_COUNT,
        globalNS);
    messageService.createQueue(QUEUE_NAME, connection);

    const handshakeDeferred = connection.sendHandshake();
    handshakeDeferred.then(() => {
        // connection established - proper communication is guaranteed now
    });

    await expect(handshakeDeferred.promise).resolves.toBeDefined();
}, 30000);

// --------------------------------------------------------------------------------------------------------------------

test("ChromiumConnection retries failed handshake inits and failed acknowledges of server-ready messages without debug logging", async () => {
    getLogger("[CHROMIUM]").level = "info";

    const globalNS = new FakeCefMessageRouter(5, 5);
    connection = new ChromiumConnection(DEFAULT_TIME_TO_LIVE,
        ChromiumConnection.DEFAULT_HANDSHAKE_RETRY_COUNT,
        globalNS);
    messageService.createQueue(QUEUE_NAME, connection);

    const handshakeDeferred = connection.sendHandshake();
    handshakeDeferred.then(() => {
        // connection established - proper communication is guaranteed now
    });

    await expect(handshakeDeferred.promise).resolves.toBeDefined();
}, 30000);

// --------------------------------------------------------------------------------------------------------------------

test("ChromiumConnection rejects failed handshake inits after max retries", async () => {
    const RETRY_COUNT = 3;

    const globalNS = new FakeCefMessageRouter(5, 0);
    connection = new ChromiumConnection(DEFAULT_TIME_TO_LIVE, RETRY_COUNT, globalNS);
    messageService.createQueue(QUEUE_NAME, connection);

    const handshakeDeferred = connection.sendHandshake();
    handshakeDeferred.catch(() => {
        // connection couldn't be established
    });

    await expect(handshakeDeferred.promise).rejects.toBeDefined();
}, 30000);

// --------------------------------------------------------------------------------------------------------------------

test("ChromiumConnection rejects failed server-ready acks after max retries", async () => {
    const RETRY_COUNT = 3;

    const globalNS = new FakeCefMessageRouter(0, 5);
    connection = new ChromiumConnection(DEFAULT_TIME_TO_LIVE, RETRY_COUNT, globalNS);
    messageService.createQueue(QUEUE_NAME, connection);

    const handshakeDeferred = connection.sendHandshake();
    handshakeDeferred.catch(() => {
        // connection couldn't be established
    });

    await expect(handshakeDeferred.promise).rejects.toBeDefined();
}, 30000);

// --------------------------------------------------------------------------------------------------------------------

class FakeSuccessCallbackCallingCefMessageRouter extends FakeCefMessageRouter {

    constructor(private delayed: boolean) {
        super(0, 0);
    }

    public cefQuery(query: any): void {
        const request = JsmsMessage.fromString(query.request);
        const response = JsmsMessage.createResponse(request, expectedResponseBody);
        if (this.delayed) {
            setTimeout(() => {
                query.onSuccess(response.toString());
            }, 500);
        }
        else {
            query.onSuccess(response.toString());
        }
    }
}

// --------------------------------------------------------------------------------------------------------------------

test("calls onSuccess callback without delay", async () => {
    const globalNS = new FakeSuccessCallbackCallingCefMessageRouter(false);
    connection = new ChromiumConnection(DEFAULT_TIME_TO_LIVE,
        ChromiumConnection.DEFAULT_HANDSHAKE_RETRY_COUNT,
        globalNS);
    messageService.createQueue(QUEUE_NAME, connection);

    const promise = new Promise<void>(resolve => {
        messageService.send(QUEUE_NAME, expectedRequestBody)
            .then(actualResponse => {
                expect(actualResponse.body).toEqual(expectedResponseBody);
                resolve();
            });
    });

    await promise;
});

// --------------------------------------------------------------------------------------------------------------------

test("calls onSuccess callback with delay", async () => {
    const globalNS = new FakeSuccessCallbackCallingCefMessageRouter(true);
    connection = new ChromiumConnection(DEFAULT_TIME_TO_LIVE,
        ChromiumConnection.DEFAULT_HANDSHAKE_RETRY_COUNT,
        globalNS);
    messageService.createQueue(QUEUE_NAME, connection);

    const promise = new Promise<void>(resolve => {
        messageService.send(QUEUE_NAME, expectedRequestBody)
            .then(actualResponse => {
                expect(actualResponse.body).toEqual(expectedResponseBody);
                resolve();
            });
    });

    await promise;
});

// --------------------------------------------------------------------------------------------------------------------

class FakeFailureCallbackCallingCefMessageRouter extends FakeCefMessageRouter {

    constructor(private delayed: boolean) {
        super(0, 0);
    }

    public cefQuery(query: any): void {
        if (this.delayed) {
            setTimeout(() => {
                query.onFailure(4711, expectedErrorMessage);
            }, 500);
        }
        else {
            query.onFailure(4711, expectedErrorMessage);
        }
    }
}

// --------------------------------------------------------------------------------------------------------------------

test("calls onFailure callback without delay", async () => {
    const globalNS = new FakeFailureCallbackCallingCefMessageRouter(false);
    connection = new ChromiumConnection(DEFAULT_TIME_TO_LIVE,
        ChromiumConnection.DEFAULT_HANDSHAKE_RETRY_COUNT,
        globalNS);
    messageService.createQueue(QUEUE_NAME, connection);

    const promise = new Promise<void>(resolve => {
        messageService.send(QUEUE_NAME, expectedRequestBody)
            .catch(errorMessage => {
                expect(errorMessage).toEqual(expectedErrorMessage);
                resolve();
            });
    });

    await promise;
});

// --------------------------------------------------------------------------------------------------------------------

test("calls onFailure callback with delay", async () => {
    const globalNS = new FakeFailureCallbackCallingCefMessageRouter(true);
    connection = new ChromiumConnection(DEFAULT_TIME_TO_LIVE,
        ChromiumConnection.DEFAULT_HANDSHAKE_RETRY_COUNT,
        globalNS);
    messageService.createQueue(QUEUE_NAME, connection);

    const promise = new Promise<void>(resolve => {
        messageService.send(QUEUE_NAME, expectedRequestBody)
            .catch(errorMessage => {
                expect(errorMessage).toEqual(expectedErrorMessage);
                resolve();
            });
    });

    await promise;
});

// --------------------------------------------------------------------------------------------------------------------

test("instantiation without arguments doesn't throw", async () => {

    let exceptionWasThrown = false;

    // @ts-ignore: required for test
    global.window = Object.create({});

    try {
        connection = new ChromiumConnection();
    }
    catch (e) {
        exceptionWasThrown = true;
    }

    expect(exceptionWasThrown).toBeFalsy();
});