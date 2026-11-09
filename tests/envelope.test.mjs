import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  ArchMcpError,
  ERROR_CODES,
  GRAPH_SCHEMA_VERSION,
  MAX_MAX_BYTES,
  SCHEMA_VERSION,
  assertIndexBuilding,
  buildIndexBlock,
  loadConfig,
  resolveMaxBytes,
  successEnvelope,
  toErrorEnvelope,
} from "../dist/lib.mjs";

test("loadConfig: дефолт бюджета 65536, таймаут 120000, allowExec выключен", () => {
  const cfg = loadConfig({});
  assert.equal(cfg.maxResponseBytes, 65_536, "дефолт бюджета — 65536");
  assert.equal(cfg.timeoutMs, 120_000, "дефолт таймаута — 120000");
  assert.equal(cfg.allowExec, false, "ARCH_MCP_ALLOW_EXEC по умолчанию выключен");
  assert.equal(cfg.autoInstall, false);
  assert.equal(cfg.stacks, "all");
});

test("loadConfig: env-бюджет выше потолка зажимается до 1048576", () => {
  const cfg = loadConfig({ ARCH_MCP_MAX_RESPONSE_BYTES: "9999999" });
  assert.equal(cfg.maxResponseBytes, MAX_MAX_BYTES);
  assert.equal(MAX_MAX_BYTES, 1_048_576);
  assert.equal(loadConfig({ ARCH_MCP_ALLOW_EXEC: "1" }).allowExec, true);
});

test("resolveMaxBytes: дефолт из cfg, явный аргумент, ошибки валидации и потолка", () => {
  assert.equal(resolveMaxBytes(undefined, 65_536), 65_536);
  assert.equal(resolveMaxBytes(null, 65_536), 65_536);
  assert.equal(resolveMaxBytes(1024, 65_536), 1024);
  assert.equal(resolveMaxBytes(1_048_576, 65_536), 1_048_576);
  for (const bad of [0, -5, 1.5, "1024", true]) {
    try {
      resolveMaxBytes(bad, 65_536);
      assert.fail(`ожидался INVALID_ARGUMENT для ${JSON.stringify(bad)}`);
    } catch (err) {
      assert.ok(err instanceof ArchMcpError, `${JSON.stringify(bad)}: не ArchMcpError`);
      assert.equal(err.code, "INVALID_ARGUMENT", `${JSON.stringify(bad)}: код ${err.code}`);
    }
  }
  try {
    resolveMaxBytes(1_048_577, 65_536);
    assert.fail("ожидался BUDGET_EXCEEDED");
  } catch (err) {
    assert.ok(err instanceof ArchMcpError);
    assert.equal(err.code, "BUDGET_EXCEEDED");
    assert.match(String(err.hint), /1048576/);
  }
});

test("successEnvelope: полный контракт конверта (ТЗ рев.3, п.3)", () => {
  const prov = { command: "c", cwd: "E:/x", git_head: "abc", ts: "2026-11-02T00:00:00.000Z", cached: false, exit_code: 0 };
  const index = buildIndexBlock({
    gitAvailable: true,
    depcruiseStatus: "ok",
    depcruiseVersion: "18.7.0",
    filesSeen: 10,
    parsed: 10,
    unsupported: [],
    graphEmpty: false,
  });
  const env = successEnvelope({
    workspace: "E:/x",
    root_used: "E:/x",
    roots: ["E:/x"],
    index,
    data: { hello: "world" },
    truncated: false,
    provenance: prov,
  });
  assert.equal(env.ok, true);
  assert.equal(env.workspace, "E:/x");
  assert.equal(env.root_used, "E:/x");
  assert.deepEqual(env.roots, ["E:/x"]);
  assert.equal(env.schema_version, SCHEMA_VERSION);
  assert.equal(typeof SCHEMA_VERSION, "number");
  assert.notEqual(SCHEMA_VERSION, undefined);
  assert.deepEqual(Object.keys(env.index).sort(), ["adapters", "coverage", "kinds", "missing", "progress", "state"]);
  assert.equal(env.index.state, "ready");
  assert.equal(env.data.hello, "world");
  assert.equal(env.truncated, false);
  assert.equal(env._meta.provenance, prov);
  assert.deepEqual(Object.keys(env._meta.provenance).sort(), ["cached", "command", "cwd", "exit_code", "git_head", "ts"].sort());
});

test("buildIndexBlock: пустой граф → state partial, не исключение", () => {
  const idx = buildIndexBlock({
    gitAvailable: true,
    depcruiseStatus: "ok",
    depcruiseVersion: "18.7.0",
    filesSeen: 0,
    parsed: 0,
    unsupported: [],
    graphEmpty: true,
  });
  assert.equal(idx.state, "partial");
  assert.equal(idx.progress.complete, false);
  assert.deepEqual(idx.missing, []);
});

test("buildIndexBlock: depcruiser недоступен → partial + missing ['depcruiser']", () => {
  const idx = buildIndexBlock({
    gitAvailable: true,
    depcruiseStatus: "not_available",
    depcruiseVersion: null,
    filesSeen: 0,
    parsed: 0,
    unsupported: [],
    graphEmpty: true,
  });
  assert.equal(idx.state, "partial");
  assert.deepEqual(idx.missing, ["depcruiser"]);
  assert.deepEqual(
    idx.adapters.map((a) => a.name),
    ["scip", "git", "depcruiser", "api", "ci", "dockerfile", "docs", "k8s", "manifests", "sql", "terraform", "tree-sitter-c", "tree-sitter-cpp", "tree-sitter-csharp", "tree-sitter-go", "tree-sitter-java", "tree-sitter-kotlin", "tree-sitter-php", "tree-sitter-python", "tree-sitter-ruby", "tree-sitter-rust", "tree-sitter-tsjs"],
  );
  assert.equal(idx.adapters.find((a) => a.name === "depcruiser")?.status, "not_available");
});

test("buildIndexBlock: непустой граф + unsupported → partial, unsupported сохраняется", () => {
  const idx = buildIndexBlock({
    gitAvailable: true,
    depcruiseStatus: "ok",
    depcruiseVersion: "18.7.0",
    filesSeen: 10,
    parsed: 9,
    unsupported: ["weird.bin"],
    graphEmpty: false,
  });
  assert.equal(idx.state, "partial");
  assert.deepEqual(idx.coverage.unsupported, ["weird.bin"]);
  assert.equal(idx.coverage.files_seen, 10);
  assert.equal(idx.coverage.parsed, 9);
  assert.ok(idx.progress.percent <= 100);
});

test("buildIndexBlock: git недоступен → partial, missing ['git']", () => {
  const idx = buildIndexBlock({
    gitAvailable: false,
    depcruiseStatus: "ok",
    depcruiseVersion: "18.7.0",
    filesSeen: 3,
    parsed: 3,
    unsupported: [],
    graphEmpty: false,
  });
  assert.equal(idx.state, "partial");
  assert.deepEqual(idx.missing, ["git"]);
});

test("assertIndexBuilding: маркер bootstrap → INDEX_BUILDING, без маркера — ок", () => {
  const dir = mkdtempSync(join(tmpdir(), "arch-mcp-marker-"));
  try {
    const marker = join(dir, ".bootstrap-in-progress");
    assert.doesNotThrow(() => assertIndexBuilding(marker));
    writeFileSync(marker, "2026-11-02T00:00:00Z", "utf8");
    try {
      assertIndexBuilding(marker);
      assert.fail("ожидался INDEX_BUILDING");
    } catch (err) {
      assert.ok(err instanceof ArchMcpError);
      assert.equal(err.code, "INDEX_BUILDING");
      assert.match(String(err.hint), /bootstrap/);
    }
    assert.ok(existsSync(marker), "маркер не удаляется проверкой");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ERROR_CODES: ровно 9 кодов контракта", () => {
  assert.equal(ERROR_CODES.length, 9);
  for (const c of [
    "WORKSPACE_NOT_FOUND",
    "NODE_NOT_FOUND",
    "AMBIGUOUS_NODE",
    "INVALID_ARGUMENT",
    "ADAPTER_UNAVAILABLE",
    "INDEX_BUILDING",
    "BUDGET_EXCEEDED",
    "SNAPSHOT_NOT_FOUND",
    "EXTERNAL_TOOL_FAILED",
  ]) {
    assert.ok(ERROR_CODES.includes(c), `нет кода ${c}`);
  }
});

test("toErrorEnvelope: ArchMcpError сохраняет код/hint/candidates, прочее → EXTERNAL_TOOL_FAILED", () => {
  const e = new ArchMcpError("AMBIGUOUS_NODE", "two nodes", { hint: "h", candidates: ["a", "b"] });
  const env = toErrorEnvelope(e);
  assert.equal(env.ok, false);
  assert.equal(env.error.code, "AMBIGUOUS_NODE");
  assert.equal(env.error.hint, "h");
  assert.deepEqual(env.error.candidates, ["a", "b"]);

  const unknown = toErrorEnvelope(new Error("boom"));
  assert.equal(unknown.ok, false);
  assert.equal(unknown.error.code, "EXTERNAL_TOOL_FAILED");
  assert.match(unknown.error.message, /boom/);

  const str = toErrorEnvelope("plain");
  assert.equal(str.error.code, "EXTERNAL_TOOL_FAILED");
  assert.equal(str.error.message, "plain");
});

test("бамп-правило: schema_version и GRAPH_SCHEMA_VERSION объявлены и разные домены", () => {
  assert.equal(typeof GRAPH_SCHEMA_VERSION, "string");
  assert.match(GRAPH_SCHEMA_VERSION, /^graph-\d+$/);
  assert.equal(typeof SCHEMA_VERSION, "number");
  // Дельта robustness (тест-план п.7): SCHEMA 5 — building-состояние index
  // (arch_status не ждёт сборку); дельта scip-indexer: SCHEMA 6 — reason в
  // index.adapters (ТЗ v6, п.2.5); graph-9 — структура кэш-записи
  // (adapterStatuses + reason), бампы независимы (R25).
  assert.equal(SCHEMA_VERSION, 6, "SCHEMA_VERSION=6 (scip-indexer)");
  assert.equal(GRAPH_SCHEMA_VERSION, "graph-9", "GRAPH_SCHEMA_VERSION=graph-9");
});
