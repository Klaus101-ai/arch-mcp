import { build } from "esbuild";

// Единая сборка: server (stdio MCP), cli (bootstrap), lib (внутренности для юнит-тестов).
// external — node:*, @asyncapi/parser (T4a: UMD-цепочка spectral/jsonc-parser
// не бандлится в ESM — динамический require внутри factory; пакет — declared
// dependency, резолвится из node_modules в рантайме) и @cdktf/hcl2json
// (T4b: MPL-2.0 — только ленивый dynamic import под ARCH_MCP_TERRAFORM=1,
// в основной бандл не линкуется; notice в THIRD_PARTY_NOTICES.md).
// Остальное бандлится (включая @modelcontextprotocol/sdk).
const common = {
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  external: ["node:*", "@asyncapi/parser", "@cdktf/hcl2json"],
  // UMD-пакеты (swagger-parser и др.) зовут require как параметр фабрики:
  // без шима esbuild падает с "Dynamic require of X is not supported".
  // createRequire от dist-файла резолвит bare-спекификаторы (util, path, …)
  // и пакеты из node_modules; внутренние модули бандла идут статически.
  banner: {
    js: "#!/usr/bin/env node\nimport { createRequire as __archCreateRequire } from \"node:module\";\nconst require = __archCreateRequire(import.meta.url);",
  },
  logLevel: "info",
};

await build({ ...common, entryPoints: ["src/index.ts"], outfile: "dist/server.mjs" });
await build({ ...common, entryPoints: ["src/cli.ts"], outfile: "dist/cli.mjs" });
await build({ ...common, entryPoints: ["src/lib.ts"], outfile: "dist/lib.mjs" });
