import pkg from "./package.json";

export default [
    // Browser-friendly UMD build
    {
        input: "index.js",
        output: {
            name: "jsms-ext-chromium",
            file: pkg.browser,
            format: "umd"
        }
    },

    // CommonJS (for Node) and ES module (for bundlers) build.
    {
        input: "index.js",
        external: ["uuid"],
        output: [
            { file: pkg.main, format: "cjs" },
            { file: pkg.module, format: "es" }
        ]
    }
]