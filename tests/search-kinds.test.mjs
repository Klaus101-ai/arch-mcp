import assert from "node:assert/strict";
import { test } from "node:test";
import { ArchMcpError, SEARCH_KINDS, search } from "../dist/lib.mjs";

// Тест-план arch-mcp-search-kinds-20261105 (ТЗ рев.3, п.1-7): kind расширен
// до file|dir|test|all + виды узлов (module|package|symbol|table|view|api|config|doc|service|container).

const REPO = "E:/1_Products/arch-mcp";

const FULL_KINDS = [
  "file",
  "dir",
  "test",
  "all",
  "module",
  "package",
  "symbol",
  "table",
  "view",
  "api",
  "config",
  "doc",
  "service",
  "container",
];

/** In-memory граф: файлы, тест, узлы всех видов; "server/src/app.ts" продублирован (дедуп). */
function makeGraph() {
  return {
    nodes: [
      "server/src/app.ts",
      "server/src/app.ts",
      "server/src/config.ts",
      "server/tests/app.test.ts",
      "table:wh.crm_request",
      "view:ai_safe.v_crm_request",
      "service:Petstore API",
      "api:GET:/pets",
      "symbol:server/src/app.ts#run",
      "package:express",
      "doc:docs/README.md",
      "config:.github/workflows/ci.yml",
      "container:Dockerfile",
    ],
    edges: [],
  };
}

const graph = makeGraph();

test("kind=service: service:Petstore API находится (id без точки); дефолтный file его не отдаёт", () => {
  const p = search(graph, REPO, "petstore", { kind: "service" });
  assert.ok(p.count >= 1, `kind=service ничего не нашёл: ${JSON.stringify(p.matches)}`);
  assert.ok(
    p.matches.some((m) => m.node === "service:Petstore API" && m.kind === "service"),
    `матчи: ${JSON.stringify(p.matches)}`,
  );

  const def = search(graph, REPO, "petstore");
  assert.equal(def.kind, "file");
  assert.equal(def.count, 0, `дефолтный file не должен отдавать service-узел: ${JSON.stringify(def.matches)}`);
});

test("kind=api: api:GET:/pets находится (id без точки); дефолтный file не отдаёт", () => {
  const p = search(graph, REPO, "pets", { kind: "api" });
  assert.ok(p.count >= 1, `kind=api ничего не нашёл: ${JSON.stringify(p.matches)}`);
  assert.ok(
    p.matches.some((m) => m.node === "api:GET:/pets" && m.kind === "api"),
    `матчи: ${JSON.stringify(p.matches)}`,
  );

  const def = search(graph, REPO, "pets");
  assert.equal(def.count, 0, `дефолтный file не должен отдавать api-узел: ${JSON.stringify(def.matches)}`);
});

test("kind=table находит table:wh.crm_request; kind=file → 0 совпадений (негативный)", () => {
  const p = search(graph, REPO, "crm_request", { kind: "table" });
  assert.ok(p.count >= 1, `kind=table ничего не нашёл: ${JSON.stringify(p.matches)}`);
  assert.ok(
    p.matches.some((m) => m.node === "table:wh.crm_request" && m.kind === "table"),
    `матчи: ${JSON.stringify(p.matches)}`,
  );

  const file = search(graph, REPO, "crm_request", { kind: "file" });
  assert.equal(file.count, 0, `kind=file не должен отдавать table-узел: ${JSON.stringify(file.matches)}`);
});

test("kind=view находит view:ai_safe.v_crm_request; в kind=all он есть с kind:'view'", () => {
  const p = search(graph, REPO, "v_crm_request", { kind: "view" });
  assert.ok(p.count >= 1, `kind=view ничего не нашёл: ${JSON.stringify(p.matches)}`);
  assert.ok(
    p.matches.some((m) => m.node === "view:ai_safe.v_crm_request" && m.kind === "view"),
    `матчи: ${JSON.stringify(p.matches)}`,
  );

  const all = search(graph, REPO, "v_crm_request", { kind: "all" });
  assert.ok(
    all.matches.some((m) => m.node === "view:ai_safe.v_crm_request" && m.kind === "view"),
    `в kind=all нет view-узла с kind:'view': ${JSON.stringify(all.matches)}`,
  );
});

test("kind=all смешивает виды: файл, тест, таблица, вью, сервис, символ — каждый с настоящим kind", () => {
  const p = search(graph, REPO, "e", { kind: "all" });
  assert.equal(p.kind, "all");
  const pick = (node) => p.matches.find((m) => m.node === node);
  assert.deepEqual(pick("server/src/app.ts"), { node: "server/src/app.ts", kind: "file" });
  assert.deepEqual(pick("server/tests/app.test.ts"), { node: "server/tests/app.test.ts", kind: "test" });
  assert.deepEqual(pick("table:wh.crm_request"), { node: "table:wh.crm_request", kind: "table" });
  assert.deepEqual(pick("view:ai_safe.v_crm_request"), { node: "view:ai_safe.v_crm_request", kind: "view" });
  assert.deepEqual(pick("service:Petstore API"), { node: "service:Petstore API", kind: "service" });
  assert.deepEqual(pick("symbol:server/src/app.ts#run"), { node: "symbol:server/src/app.ts#run", kind: "symbol" });
  assert.ok(!p.matches.some((m) => m.kind === "dir"), "каталоги в all не входят");
  const ids = p.matches.map((m) => m.node);
  assert.equal(new Set(ids).size, ids.length, `дубликаты в выдаче: ${ids.join(", ")}`);
});

test("регрессия: kind=dir — синтетические каталоги; kind=test — только тесты; kind=file — файлы и тесты без узлов с префиксом", () => {
  const dirs = search(graph, REPO, "server", { kind: "dir" });
  assert.ok(dirs.matches.some((m) => m.node === "server/src"), `нет server/src: ${JSON.stringify(dirs.matches)}`);
  assert.ok(dirs.matches.every((m) => m.kind === "dir"), "kind=dir выдаёт не dir");

  const tests = search(graph, REPO, "app", { kind: "test" });
  assert.ok(tests.count >= 1, "kind=test ничего не нашёл");
  assert.ok(tests.matches.every((m) => m.kind === "test"), `не только тесты: ${JSON.stringify(tests.matches)}`);
  assert.ok(tests.matches.some((m) => m.node === "server/tests/app.test.ts"));
  assert.ok(!tests.matches.some((m) => m.node === "server/src/app.ts"), "file-узел не должен попадать в test");

  const file = search(graph, REPO, "app", { kind: "file" });
  const ids = file.matches.map((m) => m.node);
  assert.ok(ids.includes("server/src/app.ts"), `нет app.ts: ${ids.join(", ")}`);
  assert.ok(ids.includes("server/tests/app.test.ts"), "тест должен быть в file (kind=test)");
  assert.ok(
    !ids.some((n) => FULL_KINDS.some((k) => k !== "file" && k !== "dir" && k !== "test" && n.startsWith(k + ":"))),
    `kind=file отдаёт узлы с префиксом вида: ${ids.join(", ")}`,
  );
});

test("неизвестный kind → INVALID_ARGUMENT с полным перечнем в message и hint; пустой query → INVALID_ARGUMENT", () => {
  for (const bad of ["bogus", "File", 42]) {
    try {
      search(graph, REPO, "x", { kind: bad });
      assert.fail(`ожидался INVALID_ARGUMENT для kind=${JSON.stringify(bad)}`);
    } catch (err) {
      assert.ok(err instanceof ArchMcpError, `${JSON.stringify(bad)}: не ArchMcpError`);
      assert.equal(err.code, "INVALID_ARGUMENT", `${JSON.stringify(bad)}: код ${err.code}`);
      for (const k of FULL_KINDS) {
        assert.ok(String(err.message).includes(k), `message без "${k}": ${err.message}`);
        assert.ok(String(err.hint).includes(k), `hint без "${k}": ${err.hint}`);
      }
    }
  }

  for (const k of FULL_KINDS) assert.ok(SEARCH_KINDS.includes(k), `SEARCH_KINDS без ${k}: ${SEARCH_KINDS.join("|")}`);

  try {
    search(graph, REPO, "   ");
    assert.fail("ожидался INVALID_ARGUMENT");
  } catch (err) {
    assert.ok(err instanceof ArchMcpError);
    assert.equal(err.code, "INVALID_ARGUMENT");
    assert.match(String(err.message), /query/);
  }
});
