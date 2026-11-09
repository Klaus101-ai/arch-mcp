import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { ArchMcpError, cacheRoot, loadConfig, loadFullGraph, loadSnapshotById, runTool } from "../dist/lib.mjs";

const ROOT = resolve("E:\\1_Products\\arch-mcp");
const CACHE = mkdtempSync(join(tmpdir(), "arch-mcp-rtcache-"));
const ENV = { ...process.env, ARCH_MCP_CACHE_DIR: CACHE };

function opts(cwd = ROOT) {
  return { env: ENV, cwd };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Прогрев (ТЗ v3, п.A): arch_status на холодном кэше отвечает building и не
 * ждёт сборку — поллинг до ready/partial; на прогретом кэше возвращает сразу.
 */
async function warmArchStatus(args = { workspace: ROOT }, o = opts()) {
  for (let i = 0; i < 900; i++) {
    const ctx = await runTool("arch_status", args, o);
    if (ctx.payload.index.state !== "building") return ctx;
    await sleep(100);
  }
  throw new Error("index building не завершился за 90 с");
}

test.after(() => {
  rmSync(CACHE, { recursive: true, force: true });
});

test("runTool(arch_status): полный конверт, index ready, stacks/js", async () => {
  const ctx = await warmArchStatus();
  const env = ctx.payload;
  assert.equal(env.ok, true);
  assert.equal(env.workspace, ROOT);
  assert.equal(env.root_used, ROOT);
  assert.deepEqual(env.roots, [ROOT]);
  assert.equal(env.schema_version, 6);
  assert.equal(env.index.state, "ready", `state=${env.index.state} missing=${JSON.stringify(env.index.missing)}`);
  // tree-sitter-python в списке с 2026-11-05: в пакете появился .py-файл
  // python/sqlglot_bridge.py (режим sqlglot, ТЗ arch-mcp-sqlglot-20261105) —
  // адаптер находит файл в workspace и входит в index.adapters.
  assert.deepEqual(env.index.adapters.map((a) => a.name), ["git", "depcruiser", "dockerfile", "docs", "k8s", "manifests", "tree-sitter-c", "tree-sitter-cpp", "tree-sitter-csharp", "tree-sitter-go", "tree-sitter-java", "tree-sitter-kotlin", "tree-sitter-php", "tree-sitter-python", "tree-sitter-ruby", "tree-sitter-rust", "tree-sitter-tsjs"]);
  assert.ok(env.index.coverage.files_seen > 0, "files_seen=0");
  assert.ok(env.index.coverage.parsed > 0, "parsed=0");
  assert.deepEqual(env.index.coverage.unsupported, []);
  assert.ok(env.data.stacks.stacks.includes("js"), `нет js: ${JSON.stringify(env.data.stacks)}`);
  assert.equal(env.data.git.is_repo, false, "arch-mcp не является git-репозиторием");
  // Гард на building-конверт (ТЗ v3, п.A): там data.graph = null.
  assert.ok(typeof env.data.graph?.edge_count === "number", `нет graph.edge_count: ${JSON.stringify(env.data.graph)}`);
  assert.equal(env.truncated, false);
  assert.match(env._meta.provenance.command, /arch_status/);
  assert.equal(env._meta.provenance.exit_code, 0);
  assert.equal(ctx.structuredContent, env, "structuredContent = конверт");
});

test("runTool: алиас stacks → часть arch_status (только stacks)", async () => {
  const ctx = await runTool("stacks", { repo: ROOT }, opts());
  const env = ctx.payload;
  assert.equal(env.ok, true);
  assert.equal(env.workspace, ROOT, "repo-алиас разрешается в workspace");
  assert.deepEqual(Object.keys(env.data), ["stacks"], "алиас stacks отдаёт только часть arch_status");
  assert.ok(env.data.stacks.stacks.includes("js"));
});

test("runTool: алиас get_graph → arch_snapshot.graph (nodes+edges+snapshot_id)", async () => {
  // Граф T2a вырос за счёт symbol/calls (R6) — бюджет вызова поднят выше
  // дефолтного 65536; обрезка по бюджету проверяется отдельно (max_bytes=1024).
  const ctx = await runTool("get_graph", { workspace: ROOT, max_bytes: 262_144 }, opts());
  const env = ctx.payload;
  assert.equal(env.ok, true);
  assert.ok(Array.isArray(env.data.nodes) && env.data.nodes.length > 0, "nodes пусты");
  assert.ok(Array.isArray(env.data.edges) && env.data.edges.length > 0, "edges пусты");
  assert.match(String(env.data.snapshot_id), /^[0-9a-f]{64}$/);
  assert.equal(typeof env.data.edge_count, "number");
  assert.equal(env.data.truncated, false);
});

test("runTool(arch_snapshot): snapshot_id, scope summary/full", async () => {
  const summary = await runTool("arch_snapshot", { workspace: ROOT }, opts());
  const s = summary.payload;
  assert.equal(s.ok, true);
  assert.match(String(s.data.snapshot_id), /^[0-9a-f]{64}$/);
  assert.equal(s.data.graph.nodes, undefined, "scope=summary без nodes");
  assert.ok(s.data.graph.edge_count > 0);

  const full = await runTool("arch_snapshot", { workspace: ROOT, scope: "full" }, opts());
  assert.ok(Array.isArray(full.payload.data.graph.nodes), "scope=full даёт nodes");
  assert.ok(Array.isArray(full.payload.data.graph.edges), "scope=full даёт edges");

  await assert.rejects(
    () => runTool("arch_snapshot", { workspace: ROOT, scope: "bogus" }, opts()),
    (err) => err instanceof ArchMcpError && err.code === "INVALID_ARGUMENT",
  );
});

// Дельта рев.8, тест-план п.5: sqlglot-режим через opts.env — columns только
// в focus; публичный get_graph/arch_snapshot и сохранённый снимок без ключа
// columns, schema_version=6 (дельта robustness: building-состояние index;
// дельта scip-indexer: R25 — SCHEMA 5→6, reason в index.adapters).
test("runTool: sqlglot env — get_graph/arch_snapshot без columns, сохранённый снимок без columns, schema_version=6", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "arch-mcp-sqlglotfix-"));
  try {
    const repo = join(tmp, "proj");
    mkdirSync(join(repo, "sql"), { recursive: true });
    writeFileSync(
      join(repo, "package.json"),
      JSON.stringify({ name: "sqlglotfix-fixture", version: "1.0.0", type: "module" }),
      "utf8",
    );
    writeFileSync(
      join(repo, "sql", "ddl.sql"),
      [
        "CREATE TABLE wh.target AS SELECT s.a FROM wh.source s;",
        "CREATE VIEW wh.v AS SELECT t.a FROM wh.target t;",
        "",
      ].join("\n"),
      "utf8",
    );
    const env = { ...ENV, ARCH_MCP_SQLGLOT: "1", ARCH_MCP_ALLOW_EXEC: "1" };
    const o = { env, cwd: repo };

    // opts.env доходит до loadConfig, но адаптер sql читает sqlglotModeOn() из
    // process.env (src/adapters/sql/index.ts:814) — флаги выставляются и туда
    // с гарантированным восстановлением (withEnv-паттерн sqlglot-bridge.test).
    const prevSqlglot = process.env.ARCH_MCP_SQLGLOT;
    const prevExec = process.env.ARCH_MCP_ALLOW_EXEC;
    process.env.ARCH_MCP_SQLGLOT = "1";
    process.env.ARCH_MCP_ALLOW_EXEC = "1";
    try {
      // Контроль: полный граф (без стрипа) обязан содержать lineage-columns —
      // иначе проверка «нет columns в ответе» пустая.
      const full = await loadFullGraph(repo, loadConfig(env));
      const cols = full.graph.edges.filter((e) => Array.isArray(e.meta?.columns) && e.meta.columns.length > 0);
      assert.ok(cols.length > 0, `у полного графа есть рёбра с meta.columns: ${full.graph.edges.length} рёбер`);

      const gg = await runTool("get_graph", { workspace: repo, max_bytes: 262_144 }, o);
      const genv = gg.payload;
      assert.equal(genv.ok, true, `get_graph ok: ${JSON.stringify(genv.error ?? {})}`);
      assert.equal(genv.schema_version, 6, "schema_version=6");
      assert.ok(!JSON.stringify(genv.data).includes('"columns"'), "get_graph: ключ columns отсутствует");

      const ss = await runTool("arch_snapshot", { workspace: repo, scope: "full", max_bytes: 262_144 }, o);
      const senv = ss.payload;
      assert.equal(senv.ok, true, `arch_snapshot ok: ${JSON.stringify(senv.error ?? {})}`);
      assert.equal(senv.schema_version, 6, "schema_version=6");
      assert.ok(!JSON.stringify(senv.data).includes('"columns"'), "arch_snapshot: ключ columns отсутствует");

      const stored = loadSnapshotById(cacheRoot(env), repo, String(senv.data.snapshot_id));
      assert.ok(stored, "снимок сохранён и читается по snapshot_id");
      assert.ok(!JSON.stringify(stored.graph).includes('"columns"'), "сохранённый снимок без ключа columns");
    } finally {
      if (prevSqlglot === undefined) delete process.env.ARCH_MCP_SQLGLOT;
      else process.env.ARCH_MCP_SQLGLOT = prevSqlglot;
      if (prevExec === undefined) delete process.env.ARCH_MCP_ALLOW_EXEC;
      else process.env.ARCH_MCP_ALLOW_EXEC = prevExec;
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("runTool(focus/reaches/impact/affected_tests/search): работа на живом графе", async () => {
  const focusRes = await runTool("focus", { workspace: ROOT, node: "src/config.ts" }, opts());
  const f = focusRes.payload;
  assert.equal(f.ok, true);
  assert.equal(f.data.node, "src/config.ts");
  assert.ok(f.data.counts.incoming >= 1, `incoming=${f.data.counts.incoming}`);
  assert.equal(f.data.include_type_only, false);

  const focusTo = await runTool("focus", { workspace: ROOT, node: "src/config.ts", include_type_only: true }, opts());
  assert.equal(focusTo.payload.data.include_type_only, true);

  const reach = await runTool("reaches", { workspace: ROOT, target: "src/config.ts" }, opts());
  assert.ok(reach.payload.data.results.length >= 1, "reaches пуст");

  const imp = await runTool("impact", { workspace: ROOT, changed: ["src/config.ts"] }, opts());
  assert.ok(imp.payload.data.results.length >= 1, "impact пуст");
  assert.equal(imp.payload.data.depth, 10);

  const at = await runTool("affected_tests", { workspace: ROOT, changed: ["src/config.ts"] }, opts());
  assert.ok(Array.isArray(at.payload.data.tests));
  if (at.payload.data.tests.length === 0) assert.match(String(at.payload.data.reason), /no test file depends/);

  const srch = await runTool("search", { workspace: ROOT, query: "config" }, opts());
  assert.ok(srch.payload.data.count > 0, "search ничего не нашёл");
  assert.ok(srch.payload.data.matches.some((m) => m.node === "src/config.ts"), JSON.stringify(srch.payload.data.matches));
});

test("runTool: алиасы maxDepth→max_depth, workspace важнее repo, max_depth важнее maxDepth", async () => {
  const viaAlias = await runTool("reaches", { workspace: ROOT, target: "src/config.ts", maxDepth: 1 }, opts());
  assert.ok(viaAlias.payload.data.results.length >= 1);
  assert.ok(viaAlias.payload.data.results.every((r) => r.distance === 1), "maxDepth=1 → только dist 1");

  const canonical = await runTool("reaches", { workspace: ROOT, target: "src/config.ts", max_depth: 2 }, opts());
  assert.ok(canonical.payload.data.results.every((r) => r.distance <= 2));

  const both = await runTool(
    "reaches",
    { workspace: ROOT, target: "src/config.ts", max_depth: 1, maxDepth: 5 },
    opts(),
  );
  assert.ok(both.payload.data.results.every((r) => r.distance === 1), "каноничный max_depth важнее алиаса");

  // workspace важнее repo: repo указывает на контейнер E:\, workspace — на сам arch-mcp
  const wsWins = await runTool("focus", { workspace: ROOT, repo: "E:\\", node: "src/config.ts" }, opts());
  assert.equal(wsWins.payload.workspace, ROOT, "workspace должен победить repo");

  const repoOnly = await runTool("focus", { repo: ROOT, node: "src/config.ts" }, opts());
  assert.equal(repoOnly.payload.workspace, ROOT, "старый repo работает как workspace");
});

test("runTool: max_bytes=1024 → truncated + hint, >1048576 → BUDGET_EXCEEDED", async () => {
  const small = await runTool("get_graph", { workspace: ROOT, max_bytes: 1024 }, opts());
  assert.equal(small.payload.truncated, true, "get_graph@1024 должен обрезаться");
  assert.match(String(small.payload.data.hint ?? small.payload.hint ?? ""), /ARCH_MCP_MAX_RESPONSE_BYTES|max_bytes/);

  try {
    await runTool("arch_status", { workspace: ROOT, max_bytes: 1_048_577 }, opts());
    assert.fail("ожидался BUDGET_EXCEEDED");
  } catch (err) {
    assert.ok(err instanceof ArchMcpError);
    assert.equal(err.code, "BUDGET_EXCEEDED");
  }
});

test("runTool: ошибки контракта — WORKSPACE_NOT_FOUND / NODE_NOT_FOUND / INVALID_ARGUMENT", async () => {
  try {
    await runTool("arch_status", { workspace: "E:\\no-such-workspace-xyz" }, opts());
    assert.fail("ожидался WORKSPACE_NOT_FOUND");
  } catch (err) {
    assert.ok(err instanceof ArchMcpError);
    assert.equal(err.code, "WORKSPACE_NOT_FOUND");
  }

  try {
    await runTool("focus", { workspace: ROOT, node: "src/no-such-file.ts" }, opts());
    assert.fail("ожидался NODE_NOT_FOUND");
  } catch (err) {
    assert.ok(err instanceof ArchMcpError);
    assert.equal(err.code, "NODE_NOT_FOUND");
  }

  try {
    await runTool("focus", { workspace: ROOT, node: "src/config.ts", include_type_only: "yes" }, opts());
    assert.fail("ожидался INVALID_ARGUMENT");
  } catch (err) {
    assert.ok(err instanceof ArchMcpError);
    assert.equal(err.code, "INVALID_ARGUMENT");
    assert.match(String(err.message), /include_type_only/);
  }

  try {
    await runTool("no_such_tool", { workspace: ROOT }, opts());
    assert.fail("ожидался INVALID_ARGUMENT");
  } catch (err) {
    assert.ok(err instanceof ArchMcpError);
    assert.equal(err.code, "INVALID_ARGUMENT");
    assert.match(String(err.message), /unknown tool/);
  }
});

test("runTool(arch_diff): два снимка на фикстуре temp-копии, ребро добавлено/удалено", async () => {
  const { cpSync, mkdirSync, writeFileSync } = await import("node:fs");
  const tmp = mkdtempSync(join(tmpdir(), "arch-mcp-diffrepo-"));
  try {
    const repo = join(tmp, "proj");
    mkdirSync(join(repo, "src"), { recursive: true });
    writeFileSync(join(repo, "package.json"), JSON.stringify({ name: "diffproj", version: "1.0.0", type: "module" }), "utf8");
    writeFileSync(join(repo, "src", "a.ts"), "export const a = 1;\n", "utf8");
    writeFileSync(join(repo, "src", "b.ts"), 'import { a } from "./a.ts";\nexport const b = a;\n', "utf8");

    const first = await runTool("arch_snapshot", { workspace: repo }, opts(tmp));
    const firstId = first.payload.data.snapshot_id;

    // правка в temp-копии: добавляем импорт b.ts → c.ts и узел c.ts
    writeFileSync(join(repo, "src", "c.ts"), 'import { b } from "./b.ts";\nexport const c = b;\n', "utf8");
    writeFileSync(join(repo, "src", "b.ts"), 'import { a } from "./a.ts";\nimport { c } from "./c.ts";\nexport const b = a;\n', "utf8");

    const second = await runTool("arch_snapshot", { workspace: repo }, opts(tmp));
    const secondId = second.payload.data.snapshot_id;
    assert.notEqual(firstId, secondId, "id должен смениться после правки");

    const diff = await runTool("arch_diff", { workspace: repo, from: firstId, to: secondId }, opts(tmp));
    const d = diff.payload;
    assert.equal(d.ok, true);
    assert.ok(d.data.added_nodes.some((n) => n.endsWith("src/c.ts")), `нет c.ts: ${JSON.stringify(d.data.added_nodes)}`);
    assert.ok(d.data.counts.added_edges >= 1, "должно добавиться ребро");
    assert.equal(d.data.from.snapshot_id, firstId);
    assert.equal(d.data.to.snapshot_id, secondId);

    // обратный diff: c.ts удалён
    const back = await runTool("arch_diff", { workspace: repo, from: secondId, to: firstId }, opts(tmp));
    assert.ok(back.payload.data.removed_nodes.some((n) => n.endsWith("src/c.ts")));

    // ref=HEAD-стиль: git_head отсутствует (не-git), поэтому по id; неизвестный id → SNAPSHOT_NOT_FOUND
    try {
      await runTool("arch_diff", { workspace: repo, from: "f".repeat(64), to: secondId }, opts(tmp));
      assert.fail("ожидался SNAPSHOT_NOT_FOUND");
    } catch (err) {
      assert.ok(err instanceof ArchMcpError);
      assert.equal(err.code, "SNAPSHOT_NOT_FOUND");
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
