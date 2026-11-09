// T3: SQL-адаптер и манифесты (ТЗ рев.3 §7, решения R10-R13).
// Тест-план TDD (5 случаев):
// (1) DDL: CREATE TABLE / CREATE OR REPLACE VIEW / FK → узлы table/view и рёбра reads/references;
// (2) lineage: вью ai_safe.v_crm_request читает wh.crm_request (ребро reads с файлом и строкой);
// (3) непарсящийся фрагмент не роняет адаптер и попадает в coverage;
// (4) manifests: package.json → package-узлы с версиями; requirements/pyproject/Cargo/go.mod — по одному;
// (5) детерминизм повторного прогона и отсутствие module/imports в дельтах T3 (R12).
// Плюс регистрация: sql (priority 50, syntax, Apache-2.0) и manifests (manifest, MIT)
// в builtinAdapters(), absent при нуле подходящих файлов.
// TDD-план T3.1 (вердикт T3, журнал 6185-6202):
// (6) MySQL-файл (backticks, ENGINE=) → файл в coverage.unsupported, 0 table/view-узлов, 0 self-FK;
// (7) T-SQL-файл ([dbo].[custs], GO) → то же;
// (8) requirements `rich[d]==13.6.1` → package:rich c meta.extras=["d"] и версией 13.6.1.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import * as lib from "../dist/lib.mjs";

const sql = lib.sqlAdapter;
const manifests = lib.manifestsAdapter;

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

async function scan(adapter, root) {
  return lib.runAdapter(adapter, scanCtx(root));
}

function tmpRepo(prefix) {
  return mkdtempSync(join(tmpdir(), `arch-mcp-${prefix}-`));
}

const DDL_SRC = [
  "-- схема витрины",
  "CREATE TABLE wh.dim_company (",
  "    id   uuid PRIMARY KEY,",
  "    name text NOT NULL",
  ");",
  "",
  "CREATE TABLE wh.crm_request (",
  "    id          uuid PRIMARY KEY,",
  "    company_id  uuid NOT NULL REFERENCES wh.dim_company (id),",
  "    source_id   text,",
  "    CONSTRAINT fk_req_company FOREIGN KEY (company_id) REFERENCES wh.dim_company (id)",
  ");",
  "",
  "CREATE OR REPLACE VIEW ai_safe.v_crm_request AS",
  "    SELECT id, source_id FROM wh.crm_request WHERE source_id IS NOT NULL;",
  "",
].join("\n");

test("T3-регистрация: sql и manifests в builtinAdapters(), priority/precision/license по ТЗ", () => {
  assert.ok(sql, "нет sqlAdapter в dist/lib.mjs");
  assert.ok(manifests, "нет manifestsAdapter в dist/lib.mjs");
  const ids = lib.builtinAdapters().map((a) => a.id);
  assert.deepEqual(
    ids,
    [
      "scip",
      "git",
      "depcruiser",
      "api",
      "ci",
      "dockerfile",
      "docs",
      "k8s",
      "manifests",
      "sql",
      "terraform",
      "tree-sitter-c",
      "tree-sitter-cpp",
      "tree-sitter-csharp",
      "tree-sitter-go",
      "tree-sitter-java",
      "tree-sitter-kotlin",
      "tree-sitter-php",
      "tree-sitter-python",
      "tree-sitter-ruby",
      "tree-sitter-rust",
      "tree-sitter-tsjs",
    ],
    `состав/порядок builtinAdapters: ${ids}`,
  );
  assert.equal(sql.id, "sql");
  assert.equal(sql.priority, 50, "sql: priority 50");
  assert.equal(sql.precision, "syntax", "sql: precision syntax");
  assert.equal(sql.license, "Apache-2.0", "sql: SPDX по зависимости node-sql-parser");
  assert.equal(manifests.id, "manifests");
  assert.equal(manifests.precision, "manifest", "manifests: precision manifest");
  assert.equal(manifests.license, "MIT", "manifests: своя реализация, MIT");
  for (const a of [sql, manifests]) {
    assert.ok(typeof a.version === "string" && a.version.length > 0, `${a.id}: version`);
    assert.equal(typeof a.detect, "function", `${a.id}: detect`);
    assert.equal(typeof a.scan, "function", `${a.id}: scan`);
    assert.equal(typeof a.outcome, "function", `${a.id}: outcome`);
  }
});

test("T3-1: DDL CREATE TABLE / CREATE OR REPLACE VIEW / FK → table/view-узлы и reads/references-рёбра (R10/R11)", async () => {
  assert.ok(sql, "нет sqlAdapter в dist/lib.mjs");
  const dir = tmpRepo("t3-ddl");
  try {
    mkdirSync(join(dir, "ddl"), { recursive: true });
    writeFileSync(join(dir, "ddl", "schema.sql"), DDL_SRC, "utf8");

    const run = await scan(sql, dir);
    assert.equal(run.status, "ok", `status=${run.status}`);
    const delta = run.deltas[0];
    assert.ok(delta, "дельта не вернулась");

    const byId = new Map(delta.nodes.map((n) => [n.id, n]));
    for (const id of ["table:wh.dim_company", "table:wh.crm_request", "view:ai_safe.v_crm_request"]) {
      assert.ok(byId.has(id), `нет узла ${id}: ${JSON.stringify([...byId.keys()])}`);
    }
    assert.equal(byId.get("table:wh.crm_request").kind, "table");
    assert.equal(byId.get("view:ai_safe.v_crm_request").kind, "view");
    assert.equal(byId.get("table:wh.crm_request").path, "ddl/schema.sql", "path — repo-relative путь SQL-файла");
    assert.ok(byId.has("ddl/schema.sql"), "нет file-узла SQL-файла");

    const reads = delta.edges.filter((e) => e.kind === "reads");
    const lineage = reads.find(
      (e) => e.source === "view:ai_safe.v_crm_request" && e.target === "table:wh.crm_request",
    );
    assert.ok(lineage, `нет reads-ребра lineage: ${JSON.stringify(delta.edges)}`);
    assert.equal(lineage.confidence, "syntax");
    assert.equal(lineage.file, "ddl/schema.sql");
    assert.ok(Number.isInteger(lineage.line) && lineage.line > 0, `line=${lineage.line}`);

    const fk = delta.edges.filter((e) => e.kind === "references");
    const fkEdge = fk.find((e) => e.source === "table:wh.crm_request" && e.target === "table:wh.dim_company");
    assert.ok(fkEdge, `нет references-ребра FK: ${JSON.stringify(fk)}`);
    assert.equal(fkEdge.meta?.fk, true, "FK-ребро помечено meta.fk=true");
    assert.equal(fkEdge.confidence, "syntax");

    assert.deepEqual(delta.coverage.unsupported, [], "файл разобран целиком");
    assert.equal(delta.coverage.files_seen, 1);
    assert.equal(delta.coverage.parsed, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("T3-1b: DML INSERT → writes-ребро, если разбирается node-sql-parser (R11)", async () => {
  const dir = tmpRepo("t3-dml");
  try {
    writeFileSync(
      join(dir, "load.sql"),
      "INSERT INTO wh.crm_request (id, company_id) VALUES ('a', 'b');\n",
      "utf8",
    );
    const run = await scan(sql, dir);
    assert.equal(run.status, "ok", `status=${run.status}`);
    const delta = run.deltas[0];
    const writes = delta.edges.filter((e) => e.kind === "writes");
    assert.ok(
      writes.some((e) => e.target === "table:wh.crm_request"),
      `нет writes-ребра: ${JSON.stringify(delta.edges)}`,
    );
    assert.deepEqual(delta.coverage.unsupported, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("T3-2: lineage — ai_safe.v_crm_request читает wh.crm_request ребром reads с файлом и строкой; search находит вью", async () => {
  const dir = tmpRepo("t3-lineage");
  try {
    mkdirSync(join(dir, "warehouse", "ddl"), { recursive: true });
    writeFileSync(
      join(dir, "warehouse", "ddl", "001_schema.sql"),
      "CREATE TABLE wh.crm_request (\n    id uuid PRIMARY KEY\n);\n",
      "utf8",
    );
    writeFileSync(
      join(dir, "warehouse", "ddl", "003_p1dop.sql"),
      [
        "CREATE OR REPLACE VIEW ai_safe.v_crm_request AS",
        "    SELECT r.id",
        "    FROM wh.crm_request r;",
        "",
      ].join("\n"),
      "utf8",
    );

    const run = await scan(sql, dir);
    assert.equal(run.status, "ok", `status=${run.status}`);
    const delta = run.deltas[0];

    const edge = delta.edges.find(
      (e) => e.kind === "reads" && e.source === "view:ai_safe.v_crm_request" && e.target === "table:wh.crm_request",
    );
    assert.ok(edge, `нет lineage-ребра: ${JSON.stringify(delta.edges)}`);
    assert.equal(edge.file, "warehouse/ddl/003_p1dop.sql");
    assert.ok(Number.isInteger(edge.line) && edge.line >= 3, `line=${edge.line} (строка FROM)`);
    assert.equal(edge.confidence, "syntax");

    // search(kind="view", query="v_crm_request") находит вью (acceptance svs-trans);
    // дефолтный kind=file узлы с префиксом вида не отдаёт (ТЗ рев.3, п.4).
    const graph = {
      nodes: delta.nodes.map((n) => n.id),
      edges: delta.edges.map((e) => ({ source: e.source, target: e.target, type: e.kind, meta: { type_only: false } })),
    };
    const found = lib.search(graph, dir, "v_crm_request", { kind: "view" });
    assert.ok(found.count >= 1, `search не нашёл вью: ${JSON.stringify(found.matches)}`);
    assert.ok(
      found.matches.some((m) => m.node === "view:ai_safe.v_crm_request"),
      `search-матчи: ${JSON.stringify(found.matches)}`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("T3-3: непарсящийся фрагмент не роняет адаптер и попадает в coverage (без исключения)", async () => {
  const dir = tmpRepo("t3-broken");
  try {
    writeFileSync(join(dir, "broken.sql"), "CREATE TABLE wh.broken (\n    id uuid PRIMARY KEY,\n", "utf8");
    writeFileSync(
      join(dir, "ok.sql"),
      "CREATE TABLE wh.ok_table (\n    id uuid PRIMARY KEY\n);\n",
      "utf8",
    );

    const run = await scan(sql, dir);
    assert.equal(run.status, "ok", `адаптер не должен падать: status=${run.status}`);
    const delta = run.deltas[0];
    assert.deepEqual(delta.coverage.unsupported, ["broken.sql"], `coverage: ${JSON.stringify(delta.coverage)}`);
    assert.equal(delta.coverage.files_seen, 2);
    assert.equal(delta.coverage.parsed, 1);
    assert.ok(delta.nodes.some((n) => n.id === "table:wh.ok_table"), "разобранный файл дал узел");
    assert.ok(!delta.nodes.some((n) => n.id === "table:wh.broken"), "битый CREATE TABLE не даёт узла");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("T3-4: manifests — package.json → package-узлы с версиями; requirements/pyproject/Cargo/go.mod — по одному", async () => {
  assert.ok(manifests, "нет manifestsAdapter в dist/lib.mjs");
  const dir = tmpRepo("t3-manifests");
  try {
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify(
        {
          name: "demo-app",
          version: "1.2.3",
          dependencies: { "left-pad": "1.3.0" },
          devDependencies: { typescript: "5.4.0" },
        },
        null,
        2,
      ),
      "utf8",
    );
    writeFileSync(join(dir, "requirements.txt"), "requests==2.31.0\nflask>=3.0\n", "utf8");
    writeFileSync(
      join(dir, "pyproject.toml"),
      ['[project]', 'name = "demo"', 'version = "0.1.0"', 'dependencies = ["pydantic>=2.0"]', ""].join("\n"),
      "utf8",
    );
    writeFileSync(
      join(dir, "Cargo.toml"),
      ['[package]', 'name = "demo"', 'version = "0.1.0"', "", "[dependencies]", 'serde = "1.0"', ""].join("\n"),
      "utf8",
    );
    writeFileSync(
      join(dir, "go.mod"),
      ["module example.com/demo", "", "go 1.22", "", "require (", "    github.com/pkg/errors v0.9.1", ")", ""].join(
        "\n",
      ),
      "utf8",
    );

    const run = await scan(manifests, dir);
    assert.equal(run.status, "ok", `status=${run.status}`);
    const delta = run.deltas[0];

    const expected = [
      ["package:left-pad", "1.3.0", "package.json"],
      ["package:typescript", "5.4.0", "package.json"],
      ["package:requests", "2.31.0", "requirements.txt"],
      ["package:pydantic", "2.0", "pyproject.toml"],
      ["package:serde", "1.0", "Cargo.toml"],
      ["package:github.com/pkg/errors", "v0.9.1", "go.mod"],
    ];
    const byId = new Map(delta.nodes.map((n) => [n.id, n]));
    for (const [id, version, manifest] of expected) {
      const node = byId.get(id);
      assert.ok(node, `нет package-узла ${id}: ${JSON.stringify([...byId.keys()])}`);
      assert.equal(node.kind, "package", `${id}: kind`);
      assert.equal(node.meta?.version, version, `${id}: meta.version=${node.meta?.version}`);
      assert.ok(
        delta.edges.some((e) => e.kind === "references" && e.source === manifest && e.target === id),
        `нет references-ребра ${manifest} → ${id}: ${JSON.stringify(delta.edges)}`,
      );
    }
    assert.ok(byId.has("package.json"), "нет file-узла манифеста (узел проекта)");
    assert.deepEqual(delta.coverage.unsupported, []);
    assert.equal(delta.coverage.files_seen, 5);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("T3-4b: ноль подходящих файлов → absent (не в index.adapters/missing[])", async () => {
  const dir = tmpRepo("t3-absent");
  try {
    writeFileSync(join(dir, "readme.txt"), "нет ни SQL, ни манифестов\n", "utf8");
    const sqlRun = await scan(sql, dir);
    assert.equal(sqlRun.status, "absent", `sql status=${sqlRun.status}`);
    assert.deepEqual(sqlRun.deltas, []);
    const manRun = await scan(manifests, dir);
    assert.equal(manRun.status, "absent", `manifests status=${manRun.status}`);
    assert.deepEqual(manRun.deltas, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("T3-5: детерминизм повторного прогона и отсутствие module/imports в дельтах T3 (R12)", async () => {
  const dir = tmpRepo("t3-det");
  try {
    mkdirSync(join(dir, "ddl"), { recursive: true });
    writeFileSync(join(dir, "ddl", "schema.sql"), DDL_SRC, "utf8");
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({ name: "demo", version: "1.0.0", dependencies: { "left-pad": "1.3.0" } }),
      "utf8",
    );

    const first = await scan(sql, dir);
    const second = await scan(sql, dir);
    assert.deepEqual(second.deltas, first.deltas, "sql: повторный прогон идентичен");

    const manFirst = await scan(manifests, dir);
    const manSecond = await scan(manifests, dir);
    assert.deepEqual(manSecond.deltas, manFirst.deltas, "manifests: повторный прогон идентичен");

    for (const [name, run] of [["sql", first], ["manifests", manFirst]]) {
      const delta = run.deltas[0];
      const badNodes = delta.nodes.filter((n) => n.kind === "module");
      const badEdges = delta.edges.filter((e) => e.kind === "imports");
      assert.deepEqual(badNodes, [], `${name}: module-узлы попали в legacy-счётчики (R12)`);
      assert.deepEqual(badEdges, [], `${name}: imports-рёбра попали в legacy-счётчики (R12)`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- TDD-план T3.1 (п. 6-8): чужой диалект и extras ---

const MYSQL_SRC = [
  "CREATE TABLE `customers` (",
  "    `id`      int NOT NULL AUTO_INCREMENT,",
  "    `ref_id`  int,",
  "    PRIMARY KEY (`id`),",
  "    CONSTRAINT `fk_ref` FOREIGN KEY (`ref_id`) REFERENCES `customers` (`id`)",
  ") ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;",
  "",
].join("\n");

const TSQL_SRC = [
  "CREATE TABLE [dbo].[custs] (",
  "    [id]       int NOT NULL,",
  "    [ref_id]   int,",
  "    CONSTRAINT [pk_custs] PRIMARY KEY ([id]),",
  "    CONSTRAINT [fk_ref] FOREIGN KEY ([ref_id]) REFERENCES [dbo].[custs] ([id])",
  ");",
  "GO",
  "",
].join("\n");

function assertForeignDialect(delta, file, label) {
  assert.deepEqual(
    delta.coverage.unsupported,
    [file],
    `${label}: файл должен уйти в coverage.unsupported: ${JSON.stringify(delta.coverage)}`,
  );
  assert.equal(delta.coverage.files_seen, 1, `${label}: files_seen`);
  assert.equal(delta.coverage.parsed, 0, `${label}: parsed — файл не разобран`);
  const nonFile = delta.nodes.filter((n) => n.kind !== "file");
  assert.deepEqual(nonFile.map((n) => n.id), [], `${label}: узлов вне file-узла должно быть 0`);
  const selfFk = delta.edges.filter((e) => e.source === e.target);
  assert.deepEqual(selfFk, [], `${label}: self-FK рёбер должно быть 0`);
  assert.deepEqual(delta.edges, [], `${label}: рёбер должно быть 0`);
}

test("T3.1-6: MySQL-файл (backticks, ENGINE=) → unsupported в coverage, 0 table/view-узлов, 0 self-FK", async () => {
  const dir = tmpRepo("t3-mysql");
  try {
    writeFileSync(join(dir, "schema_mysql.sql"), MYSQL_SRC, "utf8");
    const run = await scan(sql, dir);
    assert.equal(run.status, "ok", `status=${run.status}`);
    assertForeignDialect(run.deltas[0], "schema_mysql.sql", "mysql");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("T3.1-7: T-SQL-файл ([dbo].[custs], GO) → unsupported в coverage, 0 table/view-узлов, 0 self-FK", async () => {
  const dir = tmpRepo("t3-tsql");
  try {
    writeFileSync(join(dir, "schema_tsql.sql"), TSQL_SRC, "utf8");
    const run = await scan(sql, dir);
    assert.equal(run.status, "ok", `status=${run.status}`);
    assertForeignDialect(run.deltas[0], "schema_tsql.sql", "tsql");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("T3.1-8: requirements rich[d]==13.6.1 → package:rich c meta.extras=[d] и версией 13.6.1", async () => {
  const dir = tmpRepo("t3-extras");
  try {
    writeFileSync(join(dir, "requirements.txt"), "rich[d]==13.6.1\nrequests==2.31.0\n", "utf8");
    const run = await scan(manifests, dir);
    assert.equal(run.status, "ok", `status=${run.status}`);
    const delta = run.deltas[0];
    const byId = new Map(delta.nodes.map((n) => [n.id, n]));
    const rich = byId.get("package:rich");
    assert.ok(rich, `нет package:rich: ${JSON.stringify([...byId.keys()])}`);
    assert.equal(rich.kind, "package", "package:rich kind");
    assert.equal(rich.meta?.version, "13.6.1", `версия=${rich.meta?.version}`);
    assert.deepEqual(rich.meta?.extras, ["d"], `extras=${JSON.stringify(rich.meta?.extras)}`);
    assert.ok(
      delta.edges.some((e) => e.kind === "references" && e.source === "requirements.txt" && e.target === "package:rich"),
      `нет references-ребра requirements.txt → package:rich: ${JSON.stringify(delta.edges)}`,
    );
    const plain = byId.get("package:requests");
    assert.ok(plain, "нет package:requests");
    assert.equal(plain.meta?.version, "2.31.0", "requests без extras не пострадал");
    assert.equal(plain.meta?.extras, undefined, "у строки без extras поля нет");
    assert.deepEqual(delta.coverage.unsupported, [], "coverage");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
