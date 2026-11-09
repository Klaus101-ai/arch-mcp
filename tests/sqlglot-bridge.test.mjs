// ТЗ рев.5 (arch-mcp-sqlglot-20261105), тест-план п.14 (9 случаев):
// (1) CTAS (+CTE-фикстура): узел table с meta.ctas и корректными meta.columns,
//     writes file→table, reads table→источники с meta.columns, CTE не источник;
// (2) INSERT…SELECT (+CTE): writes file→таблица, reads file→источники, без columns;
// (3) ALTER-FK: references child→parent meta.fk/via=alter; слияние с inline —
//     остаётся inline-ребро и его мета (без via);
// (4) matview: узел view с meta.materialized, reads с meta.columns;
// (5) режим выключен: граф без ctas/materialized/columns/stub/via=alter;
// (6) недоступный Python: status not_available, evidence.reason, дельты = режим off;
// (7) ключи кэша: SQLGLOT 0/1, ALLOW_EXEC 0/1, правка файла моста меняют ключ,
//     кэш не смешивается;
// (8) version_mismatch: мост-заглушка (node) печатает version 30.28.0 →
//     version_mismatch=true в evidence, парс продолжается (status ok);
// (9) битый SQL и ok:false моста не роняют адаптер.
// Фикстуры — tmpRepo + env-паттерны (tests/sql-adapter.test.mjs:37-43,
// tests/exec.test.mjs:12-33, tests/cache-key.test.mjs:20-29).
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import * as lib from "../dist/lib.mjs";

const sql = lib.sqlAdapter;

function scanCtx(root, cacheDir) {
  return {
    root,
    roots: [root],
    gitHead: null,
    files: [],
    capabilities: [{ id: "scan", confidence: "syntax" }],
    cacheDir,
    timeoutMs: 60_000,
    maxBytes: 1_048_576,
  };
}

async function scan(root, cacheDir) {
  return lib.runAdapter(sql, scanCtx(root, cacheDir));
}

function tmpRepo(prefix) {
  return mkdtempSync(join(tmpdir(), `arch-mcp-${prefix}-`));
}

/** Установка/снятие env на время fn (всегда восстанавливает, включая async). */
async function withEnv(vars, fn) {
  const prev = {};
  for (const [k, v] of Object.entries(vars)) {
    prev[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return await fn();
  } finally {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

const MODE_ON = { ARCH_MCP_SQLGLOT: "1", ARCH_MCP_ALLOW_EXEC: "1" };
const MODE_OFF = { ARCH_MCP_SQLGLOT: "0", ARCH_MCP_ALLOW_EXEC: "1" };

const CTAS_SRC = [
  "CREATE TABLE wh.target AS",
  "WITH cte AS (SELECT id, name FROM wh.source_a)",
  "SELECT cte.id AS aid, b.code AS bcode",
  "FROM cte",
  "JOIN wh.source_b b ON b.id = cte.id;",
  "",
].join("\n");

const INSERT_SRC = [
  "WITH cte AS (SELECT id FROM wh.src1)",
  "INSERT INTO wh.dst SELECT cte.id FROM cte JOIN wh.src2 s2 ON s2.id = cte.id;",
  "",
].join("\n");

const ALTER_INLINE_SRC = [
  "CREATE TABLE wh.parent (id uuid PRIMARY KEY);",
  "",
  "CREATE TABLE wh.child (",
  "    id  uuid PRIMARY KEY,",
  "    pid uuid REFERENCES wh.parent (id)",
  ");",
  "",
  "ALTER TABLE wh.child ADD CONSTRAINT fk_child_parent FOREIGN KEY (pid) REFERENCES wh.parent (id);",
  "",
].join("\n");

const ALTER_ONLY_SRC = [
  "ALTER TABLE wh.child2 ADD CONSTRAINT fk2 FOREIGN KEY (pid) REFERENCES wh.parent (id);",
  "",
].join("\n");

const MATVIEW_SRC = [
  "CREATE MATERIALIZED VIEW wh.mv AS",
  "SELECT id, code FROM wh.base;",
  "",
].join("\n");

function writeSql(dir, name, src) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, name), src, "utf8");
}

// (1) CTAS + CTE
test("sqlglot-1: CTAS — узел meta.ctas/columns, writes, reads с columns, CTE не источник", async () => {
  const dir = tmpRepo("sg-ctas");
  const cache = tmpRepo("sg-ctas-cache");
  try {
    writeSql(dir, "ctas.sql", CTAS_SRC);
    const run = await withEnv(MODE_ON, () => scan(dir, cache));
    assert.equal(run.status, "ok", `status=${run.status} evidence=${JSON.stringify(run.evidence)}`);
    const delta = run.deltas[0];
    const byId = new Map(delta.nodes.map((n) => [n.id, n]));

    const target = byId.get("table:wh.target");
    assert.ok(target, `нет CTAS-узла: ${JSON.stringify([...byId.keys()])}`);
    assert.equal(target.meta?.ctas, true, "meta.ctas=true");
    assert.deepEqual(target.meta?.columns, ["aid", "bcode"], "корректные meta.columns узла");
    assert.ok(target.path === "ctas.sql", `path=${target.path}`);

    // CTE не источник и не узел
    assert.ok(![...byId.keys()].some((id) => id.endsWith(".cte")), "CTE не должен стать узлом");
    const reads = delta.edges.filter((e) => e.kind === "reads" && e.source === "table:wh.target");
    assert.equal(reads.length, 2, `reads-рёбер CTAS: ${JSON.stringify(reads)}`);
    assert.ok(!reads.some((e) => e.target.endsWith(".cte")), "CTE не источник reads");

    const ra = reads.find((e) => e.target === "table:wh.source_a");
    assert.ok(ra, `нет reads → source_a: ${JSON.stringify(reads)}`);
    assert.deepEqual(ra.meta?.columns, [{ from: "wh.source_a.id", to: "wh.target.aid" }], "columns source_a");
    const rb = reads.find((e) => e.target === "table:wh.source_b");
    assert.ok(rb, `нет reads → source_b`);
    assert.deepEqual(rb.meta?.columns, [{ from: "wh.source_b.code", to: "wh.target.bcode" }], "columns source_b");

    const writes = delta.edges.find((e) => e.kind === "writes" && e.target === "table:wh.target");
    assert.ok(writes, `нет writes CTAS: ${JSON.stringify(delta.edges)}`);
    assert.equal(writes.source, "ctas.sql", "writes source = файл");
    assert.equal(writes.file, "ctas.sql");

    // неизвестные концы — заглушки meta.stub
    assert.equal(byId.get("table:wh.source_a")?.meta?.stub, true, "source_a — stub");
    assert.equal(byId.get("table:wh.source_b")?.meta?.stub, true, "source_b — stub");

    // файл разобран (старый лексер пропускает CTAS без unsupported)
    assert.deepEqual(delta.coverage.unsupported, [], `coverage: ${JSON.stringify(delta.coverage)}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(cache, { recursive: true, force: true });
  }
});

// (2) INSERT…SELECT + CTE
test("sqlglot-2: INSERT…SELECT — writes file→таблица, reads file→источники, без meta.columns", async () => {
  const dir = tmpRepo("sg-insert");
  const cache = tmpRepo("sg-insert-cache");
  try {
    writeSql(dir, "insert.sql", INSERT_SRC);
    const run = await withEnv(MODE_ON, () => scan(dir, cache));
    assert.equal(run.status, "ok", `status=${run.status}`);
    const delta = run.deltas[0];

    const writes = delta.edges.find((e) => e.kind === "writes" && e.target === "table:wh.dst");
    assert.ok(writes, `нет writes: ${JSON.stringify(delta.edges)}`);
    assert.equal(writes.source, "insert.sql", "writes source = файл");

    const reads = delta.edges.filter((e) => e.kind === "reads" && e.source === "insert.sql");
    const targets = reads.map((e) => e.target).sort();
    assert.deepEqual(targets, ["table:wh.src1", "table:wh.src2"], `reads-источники: ${JSON.stringify(reads)}`);
    for (const r of reads) {
      assert.equal(r.meta?.columns, undefined, `у INSERT reads не должно быть columns: ${JSON.stringify(r.meta)}`);
    }
    assert.ok(!delta.edges.some((e) => e.target.endsWith(".cte")), "CTE не источник");
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(cache, { recursive: true, force: true });
  }
});

// (3) ALTER-FK: inline + alter слияние; alter-only ребро
test("sqlglot-3: ALTER-FK — via=alter; слияние с inline остаётся inline-ребром и его метой", async () => {
  const dir = tmpRepo("sg-alter");
  const cache = tmpRepo("sg-alter-cache");
  try {
    writeSql(dir, "inline.sql", ALTER_INLINE_SRC);
    writeSql(dir, "alter_only.sql", ALTER_ONLY_SRC);
    const run = await withEnv(MODE_ON, () => scan(dir, cache));
    assert.equal(run.status, "ok", `status=${run.status}`);
    const delta = run.deltas[0];

    // inline + alter, один ключ → одно ребро, мета inline (без via)
    const inline = delta.edges.filter(
      (e) => e.kind === "references" && e.source === "table:wh.child" && e.target === "table:wh.parent",
    );
    assert.equal(inline.length, 1, `дубль references child→parent: ${JSON.stringify(inline)}`);
    assert.equal(inline[0].meta?.fk, true, "meta.fk=true");
    assert.equal(inline[0].meta?.via, undefined, "inline-ребро сохранило свою мету (без via=alter)");

    // alter-only: ребро с via=alter
    const alter = delta.edges.find(
      (e) => e.kind === "references" && e.source === "table:wh.child2" && e.target === "table:wh.parent",
    );
    assert.ok(alter, `нет alter-FK child2→parent: ${JSON.stringify(delta.edges)}`);
    assert.equal(alter.meta?.fk, true, "meta.fk=true");
    assert.equal(alter.meta?.via, "alter", "meta.via=alter");
    assert.equal(alter.meta?.columns, undefined, "без колонок");
    assert.equal(alter.file, "alter_only.sql", "file alter-ребра");

    // child2 нигде не объявлен → заглушка
    const byId = new Map(delta.nodes.map((n) => [n.id, n]));
    assert.equal(byId.get("table:wh.child2")?.meta?.stub, true, "child2 — stub");
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(cache, { recursive: true, force: true });
  }
});

// (4) matview
test("sqlglot-4: matview — узел view meta.materialized, reads с meta.columns", async () => {
  const dir = tmpRepo("sg-mv");
  const cache = tmpRepo("sg-mv-cache");
  try {
    writeSql(dir, "mv.sql", MATVIEW_SRC);
    const run = await withEnv(MODE_ON, () => scan(dir, cache));
    assert.equal(run.status, "ok", `status=${run.status}`);
    const delta = run.deltas[0];
    const byId = new Map(delta.nodes.map((n) => [n.id, n]));

    const mv = byId.get("view:wh.mv");
    assert.ok(mv, `нет matview-узла: ${JSON.stringify([...byId.keys()])}`);
    assert.equal(mv.kind, "view");
    assert.equal(mv.meta?.materialized, true, "meta.materialized=true");

    const reads = delta.edges.find((e) => e.kind === "reads" && e.source === "view:wh.mv");
    assert.ok(reads, `нет reads matview: ${JSON.stringify(delta.edges)}`);
    assert.equal(reads.target, "table:wh.base");
    assert.deepEqual(
      reads.meta?.columns,
      [
        { from: "wh.base.id", to: "wh.mv.id" },
        { from: "wh.base.code", to: "wh.mv.code" },
      ],
      "columns matview reads",
    );
    assert.deepEqual(delta.coverage.unsupported, [], `coverage: ${JSON.stringify(delta.coverage)}`);
    assert.equal(byId.get("table:wh.base")?.meta?.stub, true, "base — stub");
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(cache, { recursive: true, force: true });
  }
});

// (5) режим выключен
test("sqlglot-5: режим выключен — граф без ctas/materialized/columns/stub/via=alter", async () => {
  const dir = tmpRepo("sg-off");
  const cache = tmpRepo("sg-off-cache");
  try {
    writeSql(dir, "ctas.sql", CTAS_SRC);
    writeSql(dir, "mv.sql", MATVIEW_SRC);
    writeSql(dir, "alter_only.sql", ALTER_ONLY_SRC);
    const run = await withEnv(MODE_OFF, () => scan(dir, cache));
    assert.equal(run.status, "ok", `status=${run.status}`);
    const delta = run.deltas[0];
    for (const n of delta.nodes) {
      assert.equal(n.meta?.ctas, undefined, `${n.id}: meta.ctas при выключенном режиме`);
      assert.equal(n.meta?.materialized, undefined, `${n.id}: meta.materialized при выключенном режиме`);
      assert.equal(n.meta?.stub, undefined, `${n.id}: meta.stub при выключенном режиме`);
    }
    for (const e of delta.edges) {
      assert.equal(e.meta?.columns, undefined, `${e.source}→${e.target}: meta.columns при выключенном режиме`);
      assert.equal(e.meta?.via, undefined, `${e.source}→${e.target}: meta.via при выключенном режиме`);
    }
    assert.ok(!delta.nodes.some((n) => n.id === "view:wh.mv"), "matview-узел не создаётся без режима");
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(cache, { recursive: true, force: true });
  }
});

// (6) недоступный Python → деградация
test("sqlglot-6: недоступный Python — not_available, evidence.reason, дельты = режим off", async () => {
  const dir = tmpRepo("sg-nopy");
  const cache = tmpRepo("sg-nopy-cache");
  try {
    writeSql(dir, "ctas.sql", CTAS_SRC);
    const off = await withEnv(MODE_OFF, () => scan(dir, cache));
    const bad = await withEnv(
      { ...MODE_ON, ARCH_MCP_PYTHON: "arch-mcp-no-such-python-xyz" },
      () => scan(dir, cache),
    );
    assert.equal(bad.status, "not_available", `status=${bad.status}`);
    assert.ok(bad.evidence, "evidence обязан быть при деградации");
    assert.ok(
      typeof bad.evidence.reason === "string" && bad.evidence.reason.length > 0,
      `reason в evidence: ${JSON.stringify(bad.evidence)}`,
    );
    assert.ok(Array.isArray(bad.deltas) && bad.deltas.length === 1, "дельты допустимы при not_available");
    assert.deepEqual(bad.deltas, off.deltas, "граф деградации = прежнему парсеру (режим off)");
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(cache, { recursive: true, force: true });
  }
});

// (7) ключи кэша
test("sqlglot-7: ключи кэша — SQLGLOT/ALLOW_EXEC/правка моста меняют ключ, кэш не смешивается", () => {
  const cacheDir = tmpRepo("sg-key-cache");
  const bridge = join(tmpRepo("sg-key-bridge"), "bridge.py");
  writeFileSync(bridge, "# v1\n", "utf8");
  try {
    const keyWith = (vars) =>
      withEnvSync({ ARCH_MCP_CACHE_DIR: cacheDir, ...vars }, () => {
        const cfg = lib.loadConfig(process.env);
        return lib.buildCacheKey(lib.cacheKeyInput({ gitHead: "h", status: [] }, cacheDir, cfg));
      });
    const on = keyWith({ ARCH_MCP_SQLGLOT: "1", ARCH_MCP_ALLOW_EXEC: "1" });
    const off = keyWith({ ARCH_MCP_SQLGLOT: "0", ARCH_MCP_ALLOW_EXEC: "1" });
    const noExec = keyWith({ ARCH_MCP_SQLGLOT: "1", ARCH_MCP_ALLOW_EXEC: "0" });
    assert.match(on, /^[0-9a-f]{64}$/);
    assert.notEqual(on, off, "SQLGLOT 0/1 должны давать разные ключи");
    assert.notEqual(on, noExec, "ALLOW_EXEC 0/1 должны давать разные ключи (режим требует оба)");

    const withBridge = keyWith({
      ARCH_MCP_SQLGLOT: "1",
      ARCH_MCP_ALLOW_EXEC: "1",
      ARCH_MCP_SQLGLOT_BRIDGE: bridge,
    });
    writeFileSync(bridge, "# v2 — отредактирован\n", "utf8");
    const withBridge2 = keyWith({
      ARCH_MCP_SQLGLOT: "1",
      ARCH_MCP_ALLOW_EXEC: "1",
      ARCH_MCP_SQLGLOT_BRIDGE: bridge,
    });
    assert.notEqual(withBridge, withBridge2, "правка файла моста меняет ключ");

    // кэш не смешивается: запись по одному ключу не отдаётся по другому
    lib.writeCache(cacheDir, on, { marker: "mode-on" });
    assert.deepEqual(lib.readCache(cacheDir, on), { marker: "mode-on" }, "свой ключ читается");
    assert.equal(lib.readCache(cacheDir, off), null, "чужой ключ → промах (кэш не смешивается)");
  } finally {
    rmSync(cacheDir, { recursive: true, force: true });
  }
});

/** Синхронный withEnv для ключей (buildCacheKey — sync). */
function withEnvSync(vars, fn) {
  const prev = {};
  for (const [k, v] of Object.entries(vars)) {
    prev[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return fn();
  } finally {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

// (8) version_mismatch через мост-заглушку на node
test("sqlglot-8: version 30.28.0 от моста → version_mismatch в evidence, парс продолжается", async () => {
  const dir = tmpRepo("sg-ver");
  const cache = tmpRepo("sg-ver-cache");
  const stubDir = tmpRepo("sg-ver-stub");
  try {
    writeSql(dir, "plain.sql", "CREATE TABLE wh.plain (id uuid PRIMARY KEY);\n");
    const stub = join(stubDir, "stub_bridge.mjs");
    writeFileSync(
      stub,
      [
        'import { readFileSync } from "node:fs";',
        "const req = JSON.parse(readFileSync(process.argv[2], 'utf8'));",
        "process.stdout.write(JSON.stringify({",
        '  ok: true,',
        '  version: "30.28.0",',
        "  files: req.files.map((f) => ({ path: f.path, nodes: [], edges: [], errors: [] })),",
        "  errors: [],",
        "}));",
        "",
      ].join("\n"),
      "utf8",
    );
    const run = await withEnv(
      { ...MODE_ON, ARCH_MCP_PYTHON: process.execPath, ARCH_MCP_SQLGLOT_BRIDGE: stub },
      () => scan(dir, cache),
    );
    assert.equal(run.status, "ok", `status=${run.status} evidence=${JSON.stringify(run.evidence)}`);
    const ev = run.evidence ?? {};
    assert.equal(ev.sqlglot_version, "30.28.0", `sqlglot_version: ${JSON.stringify(ev)}`);
    assert.equal(ev.version_mismatch, true, "version_mismatch=true");
    assert.match(String(ev.reason ?? ""), /30\.28\.0/, "причина несовпадения в evidence");
    // парс продолжается: старый лексер дал узел
    const delta = run.deltas[0];
    assert.ok(delta.nodes.some((n) => n.id === "table:wh.plain"), "граф построен несмотря на mismatch");
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(cache, { recursive: true, force: true });
    rmSync(stubDir, { recursive: true, force: true });
  }
});

// (10) INSERT с колоночным списком — цель exp.Schema
test("sqlglot-10: INSERT INTO t (a,b) SELECT — writes file→t, reads к источнику, без columns", async () => {
  const dir = tmpRepo("sg-insert-cols");
  const cache = tmpRepo("sg-insert-cols-cache");
  try {
    writeSql(
      dir,
      "insert_cols.sql",
      "INSERT INTO wh.dst_cols (a, b) SELECT s.a, s.b FROM wh.src_col s;\n",
    );
    const run = await withEnv(MODE_ON, () => scan(dir, cache));
    assert.equal(run.status, "ok", `status=${run.status} evidence=${JSON.stringify(run.evidence)}`);
    const delta = run.deltas[0];

    const writes = delta.edges.find((e) => e.kind === "writes" && e.target === "table:wh.dst_cols");
    assert.ok(writes, `нет writes (цель exp.Schema?): ${JSON.stringify(delta.edges)}`);
    assert.equal(writes.source, "insert_cols.sql", "writes source = файл");

    const reads = delta.edges.find((e) => e.kind === "reads" && e.source === "insert_cols.sql");
    assert.ok(reads, `нет reads: ${JSON.stringify(delta.edges)}`);
    assert.equal(reads.target, "table:wh.src_col", "reads к источнику SELECT");
    assert.equal(reads.meta?.columns, undefined, "у INSERT reads нет columns");
    assert.ok(!delta.edges.some((e) => e.target.endsWith(".cte")), "CTE не источник");
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(cache, { recursive: true, force: true });
  }
});

// (11) WITH … INSERT … SELECT — CTE-обёртка и колоночный список
test("sqlglot-11: WITH c AS (…) INSERT INTO t (a) SELECT — writes есть, reads к источнику в c, c не источник", async () => {
  const dir = tmpRepo("sg-insert-with");
  const cache = tmpRepo("sg-insert-with-cache");
  try {
    writeSql(
      dir,
      "insert_with.sql",
      "WITH c AS (SELECT id FROM wh.src_c)\nINSERT INTO wh.dst_w (id) SELECT c.id FROM c;\n",
    );
    const run = await withEnv(MODE_ON, () => scan(dir, cache));
    assert.equal(run.status, "ok", `status=${run.status} evidence=${JSON.stringify(run.evidence)}`);
    const delta = run.deltas[0];

    const writes = delta.edges.find((e) => e.kind === "writes" && e.target === "table:wh.dst_w");
    assert.ok(writes, `нет writes у WITH…INSERT: ${JSON.stringify(delta.edges)}`);
    assert.equal(writes.source, "insert_with.sql", "writes source = файл");

    const reads = delta.edges.filter((e) => e.kind === "reads" && e.source === "insert_with.sql");
    const targets = reads.map((e) => e.target);
    assert.deepEqual(targets, ["table:wh.src_c"], `reads-источники: ${JSON.stringify(reads)}`);
    assert.ok(!targets.some((t) => t.endsWith(".cte")), "c — не источник");
    assert.ok(!delta.edges.some((e) => e.target.endsWith(".cte")), "CTE не источник reads");
    for (const r of reads) {
      assert.equal(r.meta?.columns, undefined, `у INSERT reads нет columns: ${JSON.stringify(r.meta)}`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(cache, { recursive: true, force: true });
  }
});

// (9) битый SQL и ok:false моста не роняют адаптер
test("sqlglot-9: битый SQL и ok:false моста не роняют адаптер", async () => {
  const dir = tmpRepo("sg-broken");
  const cache = tmpRepo("sg-broken-cache");
  const stubDir = tmpRepo("sg-broken-stub");
  try {
    writeSql(dir, "broken.sql", "CREATE TABLE wh.broken (\n    id uuid PRIMARY KEY,\n");
    writeSql(dir, "ok.sql", CTAS_SRC);
    // битый SQL при живом мосте: адаптер жив, broken в unsupported, CTAS разобран
    const run = await withEnv(MODE_ON, () => scan(dir, cache));
    assert.equal(run.status, "ok", `status=${run.status} evidence=${JSON.stringify(run.evidence)}`);
    const delta = run.deltas[0];
    assert.ok(delta.coverage.unsupported.includes("broken.sql"), `unsupported: ${JSON.stringify(delta.coverage)}`);
    assert.ok(delta.nodes.some((n) => n.id === "table:wh.target"), "CTAS из второго файла разобран");
    assert.ok(!delta.nodes.some((n) => n.id === "table:wh.broken"), "битый CREATE не даёт узла");

    // ok:false моста → деградация без падения
    const stub = join(stubDir, "fail_bridge.mjs");
    writeFileSync(stub, 'process.stdout.write(JSON.stringify({ ok: false, errors: ["boom"] }));\n', "utf8");
    const fail = await withEnv(
      { ...MODE_ON, ARCH_MCP_PYTHON: process.execPath, ARCH_MCP_SQLGLOT_BRIDGE: stub },
      () => scan(dir, cache),
    );
    assert.equal(fail.status, "not_available", `ok:false → not_available, status=${fail.status}`);
    assert.ok(fail.evidence?.reason, "reason при ok:false");
    assert.ok(Array.isArray(fail.deltas) && fail.deltas.length === 1, "дельты при деградации");
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(cache, { recursive: true, force: true });
    rmSync(stubDir, { recursive: true, force: true });
  }
});
