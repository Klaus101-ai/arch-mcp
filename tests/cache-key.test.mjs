import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { buildCacheKey, cacheKeyInput, GRAPH_SCHEMA_VERSION, loadConfig } from "../dist/lib.mjs";

// T1.1 (вердикт 4103): режим парсера depcruiser обязан входить в канонический
// ключ кэша — запись, сделанная через --no-config, не должна отдаваться по
// ключу прогона с --config (parser=tsc).

const BASE = {
  head: "0123456789abcdef0123456789abcdef01234567",
  mtimes: [{ path: "src/a.ts", mtimeMs: 1700000000000 }],
  toolchainVersion: "18.7.0",
  configHashes: { stacks: "abc" },
  packageVersion: "0.1.0",
};

function withCacheDir(dir, fn) {
  const prev = process.env.ARCH_MCP_CACHE_DIR;
  process.env.ARCH_MCP_CACHE_DIR = dir;
  try {
    return fn();
  } finally {
    if (prev === undefined) delete process.env.ARCH_MCP_CACHE_DIR;
    else process.env.ARCH_MCP_CACHE_DIR = prev;
  }
}

// graph-6 (T2a, 2026-11-03): пайплайн tree-sitter; graph-7 (2026-11-05, sqlglot):
// режим ARCH_MCP_SQLGLOT меняет форму графа (ctas/materialized/columns/stub/via)
// и состав configHashes — ключи кэша режимов не смешиваются.
// graph-8 (2026-11-06, robustness): структура кэш-записи — adapterStatuses и
// degraded{reason,ts} (ТЗ v3, п.B) → бамп по правилу R25.
// graph-9 (2026-11-07, scip-indexer): adapterStatuses + reason (причина
// not_available индексера scip, ТЗ v6, п.2.5) → бамп по правилу R25.
test("GRAPH_SCHEMA_VERSION: бамп graph-8 → graph-9 (структура кэш-записи)", () => {
  assert.equal(GRAPH_SCHEMA_VERSION, "graph-9");
});

test("buildCacheKey: parser tsc-config и no-config дают разные ключи", () => {
  const withConfig = buildCacheKey({ ...BASE, parser: "tsc-config" });
  const noConfig = buildCacheKey({ ...BASE, parser: "no-config" });
  assert.match(withConfig, /^[0-9a-f]{64}$/);
  assert.match(noConfig, /^[0-9a-f]{64}$/);
  assert.notEqual(withConfig, noConfig);
});

test("buildCacheKey: детерминизм — одинаковые входы и порядок mtimes не меняют ключ", () => {
  const a = buildCacheKey({ ...BASE, parser: "tsc-config" });
  const b = buildCacheKey({ ...BASE, parser: "tsc-config" });
  assert.equal(a, b);
  const reordered = buildCacheKey({
    ...BASE,
    mtimes: [...BASE.mtimes, { path: "src/b.ts", mtimeMs: 1700000001000 }].reverse(),
    parser: "tsc-config",
  });
  const reorderedSame = buildCacheKey({
    ...BASE,
    mtimes: [
      { path: "src/b.ts", mtimeMs: 1700000001000 },
      { path: "src/a.ts", mtimeMs: 1700000000000 },
    ],
    parser: "tsc-config",
  });
  assert.equal(reordered, reorderedSame);
  assert.notEqual(a, reordered);
});

test("cacheKeyInput: нормальная среда → parser=tsc-config (конфиг пишется в кэш)", () => {
  const dir = mkdtempSync(join(tmpdir(), "archmcp-key-ok-"));
  try {
    const input = withCacheDir(dir, () =>
      cacheKeyInput({ gitHead: "h", status: [] }, dir, loadConfig(process.env)),
    );
    assert.equal(input.parser, "tsc-config");
    const key = buildCacheKey(input);
    const noConfigKey = buildCacheKey({ ...input, parser: "no-config" });
    assert.notEqual(key, noConfigKey);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("cacheKeyInput: кэш-каталог недоступен → parser=no-config и другой ключ", () => {
  const dir = mkdtempSync(join(tmpdir(), "archmcp-key-blocked-"));
  try {
    // файл там, где должен быть каталогом кэша → запись depcruise.config.json падает
    const blocker = join(dir, "blocker");
    writeFileSync(blocker, "", "utf8");
    const input = withCacheDir(blocker, () =>
      cacheKeyInput({ gitHead: "h", status: [] }, dir, loadConfig(process.env)),
    );
    assert.equal(input.parser, "no-config");
    assert.notEqual(buildCacheKey(input), buildCacheKey({ ...input, parser: "tsc-config" }));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
