// T4a: API-адаптер (ТЗ рев.3 §7, решения R14-R17).
// Тест-план TDD (5 случаев + битые файлы):
// (1) OpenAPI 3.1 YAML → service:<title> + api:<METHOD>:<path>, path — файл-источник;
// (2) Swagger 2.0 JSON → те же узлы и рёбра;
// (3) .proto → api:<package>.<service>/<method> с пакетом/сервисом в meta;
// (4) GraphQL SDL → api:Query.<field>/api:Mutation.<field> — без рёбер (заголовка нет, R15);
// (5) AsyncAPI YAML → api:<channel>, service:<title> и references-ребро при заголовке (R15);
// плюс: битый файл каждого формата → coverage.unsupported, узлов 0, без исключения;
// внешний $ref → unsupported без резолва (R17); ноль API-файлов → absent;
// регистрация api (priority 50, precision syntax) в builtinAdapters();
// search находит операцию/канал по имени (R14: id узлов).
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import * as lib from "../dist/lib.mjs";

const api = lib.apiAdapter;

function scanCtx(root) {
  return {
    root,
    roots: [root],
    gitHead: null,
    files: [],
    capabilities: [{ id: "scan", confidence: "syntax" }],
    cacheDir: "",
    timeoutMs: 60_000,
    maxBytes: 1_048_576,
  };
}

async function scan(root) {
  return lib.runAdapter(api, scanCtx(root));
}

function tmpRepo(prefix) {
  return mkdtempSync(join(tmpdir(), `arch-mcp-${prefix}-`));
}

function toGraph(delta) {
  return {
    nodes: delta.nodes.map((n) => n.id),
    edges: delta.edges.map((e) => ({ source: e.source, target: e.target, type: e.kind, meta: { type_only: false } })),
  };
}

const OPENAPI_31 = [
  "openapi: 3.1.0",
  "info:",
  "  title: Petstore API",
  "  version: 1.0.0",
  "paths:",
  "  /pets:",
  "    get:",
  "      operationId: listPets",
  "      responses:",
  "        '200': { description: ok }",
  "    post:",
  "      operationId: createPet",
  "      responses:",
  "        '201': { description: created }",
  "  /pets.csv:",
  "    get:",
  "      operationId: exportPets",
  "      responses:",
  "        '200': { description: ok }",
  "",
].join("\n");

const SWAGGER_20 = JSON.stringify(
  {
    swagger: "2.0",
    info: { title: "Petstore API", version: "1.0.0" },
    paths: {
      "/pets": {
        get: { operationId: "listPets", responses: { "200": { description: "ok" } } },
        post: { operationId: "createPet", responses: { "201": { description: "created" } } },
      },
    },
  },
  null,
  2,
);

const PROTO_SRC = [
  'syntax = "proto3";',
  "",
  "package example.v1;",
  "",
  "message HelloRequest {",
  "  string name = 1;",
  "}",
  "",
  "message HelloReply {",
  "  string message = 1;",
  "}",
  "",
  "service Greeter {",
  "  rpc SayHello (HelloRequest) returns (HelloReply);",
  "}",
  "",
].join("\n");

const GRAPHQL_SRC = [
  "type Query {",
  "  pets: [Pet!]!",
  "  pet(id: ID!): Pet",
  "}",
  "",
  "type Mutation {",
  "  addPet(input: AddPetInput!): Pet",
  "}",
  "",
  "type Pet {",
  "  id: ID!",
  "  name: String!",
  "}",
  "",
].join("\n");

const ASYNCAPI_SRC = [
  "asyncapi: 2.6.0",
  "info:",
  "  title: Events API",
  "  version: 1.0.0",
  "channels:",
  "  user.signedup:",
  "    subscribe:",
  "      message:",
  "        payload:",
  "          type: object",
  "  order.created:",
  "    subscribe:",
  "      message:",
  "        payload:",
  "          type: object",
  "",
].join("\n");

test("T4a-регистрация: api в builtinAdapters(), priority 50, precision syntax, license SPDX-состав", () => {
  assert.ok(api, "нет apiAdapter в dist/lib.mjs");
  const ids = lib.builtinAdapters().map((a) => a.id);
  assert.ok(ids.includes("api"), `нет api в builtinAdapters: ${ids}`);
  assert.equal(api.id, "api");
  assert.equal(api.priority, 50, "api: priority 50");
  assert.equal(api.precision, "syntax", "api: precision syntax");
  assert.equal(api.license, "Apache-2.0 AND BSD-3-Clause AND MIT", "api: SPDX-состав зависимостей T4a");
  assert.ok(typeof api.version === "string" && api.version.length > 0, "api: version");
  assert.equal(typeof api.detect, "function", "api: detect");
  assert.equal(typeof api.scan, "function", "api: scan");
  assert.equal(typeof api.outcome, "function", "api: outcome");
  // Сортировка: priority 50 → группа после depcruiser (100), внутри — по id: api < manifests < sql.
  const i = ids.indexOf("api");
  assert.ok(i > ids.indexOf("depcruiser"), `api должен идти после depcruiser: ${ids}`);
  assert.ok(i < ids.indexOf("manifests"), `api должен идти перед manifests: ${ids}`);
});

test("T4a-1: OpenAPI 3.1 YAML → service + api-узлы операций, ссылка на файл (R14/R15)", async () => {
  const dir = tmpRepo("t4a-openapi");
  try {
    writeFileSync(join(dir, "openapi.yaml"), OPENAPI_31, "utf8");
    const run = await scan(dir);
    assert.equal(run.status, "ok", `status=${run.status}`);
    const delta = run.deltas[0];
    assert.ok(delta, "дельта не вернулась");

    const byId = new Map(delta.nodes.map((n) => [n.id, n]));
    const svc = byId.get("service:Petstore API");
    assert.ok(svc, `нет service-узла: ${JSON.stringify([...byId.keys()])}`);
    assert.equal(svc.kind, "service");
    assert.equal(svc.path, "openapi.yaml", "service.path — файл-источник");

    for (const id of ["api:GET:/pets", "api:POST:/pets", "api:GET:/pets.csv"]) {
      const op = byId.get(id);
      assert.ok(op, `нет api-узла ${id}: ${JSON.stringify([...byId.keys()])}`);
      assert.equal(op.kind, "api", `${id}: kind`);
      assert.equal(op.path, "openapi.yaml", `${id}: path — файл-источник`);
    }

    for (const id of ["api:GET:/pets", "api:POST:/pets", "api:GET:/pets.csv"]) {
      const edge = delta.edges.find((e) => e.source === id && e.target === "service:Petstore API");
      assert.ok(edge, `нет ребра ${id} → service: ${JSON.stringify(delta.edges)}`);
      assert.equal(edge.kind, "references", `${id}: kind references`);
      assert.equal(edge.confidence, "syntax", `${id}: confidence syntax`);
      assert.equal(edge.file, "openapi.yaml", `${id}: ребро ссылается на файл-источник`);
    }

    assert.deepEqual(delta.coverage.unsupported, [], `coverage: ${JSON.stringify(delta.coverage)}`);
    assert.equal(delta.coverage.files_seen, 1);
    assert.equal(delta.coverage.parsed, 1);

    // R16: legacy-счётчики не трогаются — module/imports адаптер не порождает.
    assert.deepEqual(delta.nodes.filter((n) => n.kind === "module"), [], "R16: module-узлов нет");
    assert.deepEqual(delta.edges.filter((e) => e.kind === "imports"), [], "R16: imports-рёбер нет");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("T4a-2: Swagger 2.0 JSON → те же узлы и рёбра (R14/R15)", async () => {
  const dir = tmpRepo("t4a-swagger");
  try {
    writeFileSync(join(dir, "swagger.json"), SWAGGER_20, "utf8");
    const run = await scan(dir);
    assert.equal(run.status, "ok", `status=${run.status}`);
    const delta = run.deltas[0];

    const byId = new Map(delta.nodes.map((n) => [n.id, n]));
    const svc = byId.get("service:Petstore API");
    assert.ok(svc, `нет service-узла: ${JSON.stringify([...byId.keys()])}`);
    assert.equal(svc.kind, "service");
    assert.equal(svc.path, "swagger.json");

    for (const id of ["api:GET:/pets", "api:POST:/pets"]) {
      const op = byId.get(id);
      assert.ok(op, `нет api-узла ${id}: ${JSON.stringify([...byId.keys()])}`);
      assert.equal(op.kind, "api");
      assert.equal(op.path, "swagger.json");
      const edge = delta.edges.find((e) => e.source === id && e.target === "service:Petstore API");
      assert.ok(edge, `нет ребра ${id} → service: ${JSON.stringify(delta.edges)}`);
      assert.equal(edge.kind, "references");
      assert.equal(edge.confidence, "syntax");
      assert.equal(edge.file, "swagger.json");
    }
    assert.deepEqual(delta.coverage.unsupported, []);
    assert.equal(delta.coverage.files_seen, 1);
    assert.equal(delta.coverage.parsed, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("T4a-3: .proto → api-узлы методов с пакетом/сервисом и ребро к service (R14/R15)", async () => {
  const dir = tmpRepo("t4a-proto");
  try {
    writeFileSync(join(dir, "greeter.proto"), PROTO_SRC, "utf8");
    const run = await scan(dir);
    assert.equal(run.status, "ok", `status=${run.status}`);
    const delta = run.deltas[0];

    const byId = new Map(delta.nodes.map((n) => [n.id, n]));
    const svc = byId.get("service:example.v1.Greeter");
    assert.ok(svc, `нет service-узла: ${JSON.stringify([...byId.keys()])}`);
    assert.equal(svc.kind, "service");
    assert.equal(svc.path, "greeter.proto");

    const method = byId.get("api:example.v1.Greeter/SayHello");
    assert.ok(method, `нет api-узла метода: ${JSON.stringify([...byId.keys()])}`);
    assert.equal(method.kind, "api");
    assert.equal(method.path, "greeter.proto");
    assert.equal(method.meta?.package, "example.v1", "meta.package");
    assert.equal(method.meta?.service, "Greeter", "meta.service");

    const edge = delta.edges.find(
      (e) => e.source === "api:example.v1.Greeter/SayHello" && e.target === "service:example.v1.Greeter",
    );
    assert.ok(edge, `нет ребра метод → service: ${JSON.stringify(delta.edges)}`);
    assert.equal(edge.kind, "references");
    assert.equal(edge.confidence, "syntax");
    assert.equal(edge.file, "greeter.proto");

    assert.deepEqual(delta.coverage.unsupported, []);
    assert.equal(delta.coverage.files_seen, 1);
    assert.equal(delta.coverage.parsed, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("T4a-4: GraphQL SDL → api-узлы полей Query/Mutation, без рёбер — заголовка нет (R14/R15)", async () => {
  const dir = tmpRepo("t4a-graphql");
  try {
    writeFileSync(join(dir, "schema.graphql"), GRAPHQL_SRC, "utf8");
    const run = await scan(dir);
    assert.equal(run.status, "ok", `status=${run.status}`);
    const delta = run.deltas[0];

    const byId = new Map(delta.nodes.map((n) => [n.id, n]));
    for (const id of ["api:Query.pets", "api:Query.pet", "api:Mutation.addPet"]) {
      const node = byId.get(id);
      assert.ok(node, `нет api-узла ${id}: ${JSON.stringify([...byId.keys()])}`);
      assert.equal(node.kind, "api", `${id}: kind`);
      assert.equal(node.path, "schema.graphql", `${id}: path — файл-источник`);
    }
    assert.equal(byId.get("api:Query.pets")?.meta?.root, "Query", "meta.root");
    assert.equal(byId.get("api:Mutation.addPet")?.meta?.root, "Mutation", "meta.root");

    // Заголовка у GraphQL нет → service-узла нет и рёбер нет (R15: узел без ребра).
    assert.deepEqual(delta.nodes.filter((n) => n.kind === "service"), [], "service-узлов быть не должно");
    assert.deepEqual(delta.edges, [], `рёбер быть не должно: ${JSON.stringify(delta.edges)}`);

    assert.deepEqual(delta.coverage.unsupported, []);
    assert.equal(delta.coverage.files_seen, 1);
    assert.equal(delta.coverage.parsed, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("T4a-5: AsyncAPI YAML → api-узлы каналов + service и ребро при заголовке (R14/R15)", async () => {
  const dir = tmpRepo("t4a-asyncapi");
  try {
    writeFileSync(join(dir, "asyncapi.yaml"), ASYNCAPI_SRC, "utf8");
    const run = await scan(dir);
    assert.equal(run.status, "ok", `status=${run.status}`);
    const delta = run.deltas[0];

    const byId = new Map(delta.nodes.map((n) => [n.id, n]));
    const svc = byId.get("service:Events API");
    assert.ok(svc, `нет service-узла: ${JSON.stringify([...byId.keys()])}`);
    assert.equal(svc.kind, "service");
    assert.equal(svc.path, "asyncapi.yaml");

    for (const id of ["api:user.signedup", "api:order.created"]) {
      const node = byId.get(id);
      assert.ok(node, `нет api-узла канала ${id}: ${JSON.stringify([...byId.keys()])}`);
      assert.equal(node.kind, "api", `${id}: kind`);
      assert.equal(node.path, "asyncapi.yaml", `${id}: path — файл-источник`);
      const edge = delta.edges.find((e) => e.source === id && e.target === "service:Events API");
      assert.ok(edge, `нет ребра ${id} → service: ${JSON.stringify(delta.edges)}`);
      assert.equal(edge.kind, "references");
      assert.equal(edge.confidence, "syntax");
      assert.equal(edge.file, "asyncapi.yaml");
    }

    assert.deepEqual(delta.coverage.unsupported, []);
    assert.equal(delta.coverage.files_seen, 1);
    assert.equal(delta.coverage.parsed, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

const BROKEN = [
  [
    "openapi-broken.yaml",
    ["openapi: 3.1.0", "info:", "  title: [unclosed", "  version: 1.0.0", "paths: {}", ""].join("\n"),
  ],
  ["swagger-broken.json", '{"swagger": "2.0", "info": {"title": "X", "version": "1.0.0",'],
  ["broken.proto", ['syntax = "proto3";', "service Greeter {", "  rpc SayHello HelloRequest returns HelloReply;", "}", ""].join("\n")],
  ["broken.graphql", ["type Query {", "  pets: [Pet!]!", "", ""].join("\n")],
  ["asyncapi-broken.yaml", ["asyncapi: 2.6.0", "info:", "  title: [broken", ""].join("\n")],
];

test("T4a-6: битый файл каждого формата → unsupported, узлов 0, без исключения (R17)", async () => {
  for (const [file, src] of BROKEN) {
    const dir = tmpRepo("t4a-broken");
    try {
      writeFileSync(join(dir, file), src, "utf8");
      const run = await scan(dir);
      assert.equal(run.status, "ok", `${file}: адаптер не должен падать, status=${run.status}`);
      const delta = run.deltas[0];
      assert.ok(delta, `${file}: дельта не вернулась`);
      assert.deepEqual(delta.coverage.unsupported, [file], `${file}: coverage ${JSON.stringify(delta.coverage)}`);
      assert.equal(delta.coverage.files_seen, 1, `${file}: files_seen`);
      assert.equal(delta.coverage.parsed, 0, `${file}: parsed`);
      assert.deepEqual(delta.nodes, [], `${file}: узлов 0, got ${JSON.stringify(delta.nodes.map((n) => n.id))}`);
      assert.deepEqual(delta.edges, [], `${file}: рёбер 0`);
      // R17: unsupported с причиной — текст ошибки разбора в evidence.
      const reason = run.evidence?.unsupported_reasons?.[file];
      assert.ok(typeof reason === "string" && reason.length > 0, `${file}: нет причины unsupported: ${JSON.stringify(run.evidence)}`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

test("T4a-7: внешний $ref → unsupported без резолва (R17)", async () => {
  const dir = tmpRepo("t4a-extref");
  try {
    writeFileSync(
      join(dir, "openapi-ext.yaml"),
      [
        "openapi: 3.1.0",
        "info:",
        "  title: Ext API",
        "  version: 1.0.0",
        "paths:",
        "  /pets:",
        "    get:",
        "      responses:",
        "        '200':",
        "          description: ok",
        "          content:",
        "            application/json:",
        "              schema:",
        "                $ref: 'https://example.com/schemas/pet.json'",
        "",
      ].join("\n"),
      "utf8",
    );
    const run = await scan(dir);
    assert.equal(run.status, "ok", `status=${run.status}`);
    const delta = run.deltas[0];
    assert.deepEqual(delta.coverage.unsupported, ["openapi-ext.yaml"], `coverage: ${JSON.stringify(delta.coverage)}`);
    assert.equal(delta.coverage.parsed, 0);
    assert.deepEqual(delta.nodes, [], `внешний $ref не даёт узлов: ${JSON.stringify(delta.nodes.map((n) => n.id))}`);
    const reason = run.evidence?.unsupported_reasons?.["openapi-ext.yaml"];
    assert.ok(typeof reason === "string" && reason.length > 0, `нет причины: ${JSON.stringify(run.evidence)}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("T4a-8: ноль API-файлов → absent (не в index.adapters/missing[])", async () => {
  const dir = tmpRepo("t4a-absent");
  try {
    writeFileSync(join(dir, "readme.txt"), "здесь нет API-описаний\n", "utf8");
    const run = await scan(dir);
    assert.equal(run.status, "absent", `status=${run.status}`);
    assert.deepEqual(run.deltas, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("T4a-9: search находит операцию и канал по имени (R14)", async () => {
  const dir = tmpRepo("t4a-search");
  try {
    writeFileSync(join(dir, "openapi.yaml"), OPENAPI_31, "utf8");
    writeFileSync(join(dir, "asyncapi.yaml"), ASYNCAPI_SRC, "utf8");
    const run = await scan(dir);
    assert.equal(run.status, "ok", `status=${run.status}`);
    const delta = run.deltas[0];
    const graph = toGraph(delta);

    const op = lib.search(graph, dir, "pets.csv", { kind: "api" });
    assert.ok(op.count >= 1, `search не нашёл операцию: ${JSON.stringify(op.matches)}`);
    assert.ok(
      op.matches.some((m) => m.node === "api:GET:/pets.csv"),
      `search-матчи операции: ${JSON.stringify(op.matches)}`,
    );

    const ch = lib.search(graph, dir, "signedup", { kind: "api" });
    assert.ok(ch.count >= 1, `search не нашёл канал: ${JSON.stringify(ch.matches)}`);
    assert.ok(
      ch.matches.some((m) => m.node === "api:user.signedup"),
      `search-матчи канала: ${JSON.stringify(ch.matches)}`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
