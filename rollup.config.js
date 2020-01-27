import pkg from "./package.json";

export default [
    // Browser-friendly UMD build
    {
        input: "index.js",
        external: ["jsms", "@log4js-node/log4js-api"],
        output: {
            name: "jsms",
            file: pkg.browser,
            format: "umd"
        }
    },

    // CommonJS (for Node) and ES module (for bundlers) build.
    {
        input: "index.js",
        external: ["uuid", "jsms", "@log4js-node/log4js-api"],
        output: [
            { file: pkg.main, format: "cjs" },
            { file: pkg.module, format: "es" }
        ]
    }
]