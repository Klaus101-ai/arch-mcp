// T1.2b: ядро на реестре адаптеров. Тестовые адаптеры — заглушки внутри теста.
// Кейсы: (1) ключ кэша меняется при смене состава/версии адаптеров;
// (2) index.adapters строится динамически из реестра (одна регистрация);
// (3) отсутствующий/падающий адаптер → missing[], ядро не падает;
// (4) обёртки git (R3: граф не даёт) и depcruiser (module/imports, MIT, priority 100).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";
import * as lib from "../dist/lib.mjs";

const ROOT = resolve("E:\\1_Products\\arch-mcp");
const FIXTURE = resolve("E:\\1_Products\\arch-mcp\\tests\\fixtures\\depcruiser-asi-agent1.json");

const stub = (id, priority, version = "9.9.9") => ({
  id,
  version,
  license: "MIT",
  precision: "syntax",
  priority,
  detect: async () => [{ id, confidence: "syntax" }],
  scan: async function* () {},
});

test("экспорты T1.2b: обёртки и подпись состава в dist/lib.mjs", () => {
  assert.equal(typeof lib.gitAdapter, "object", "нет gitAdapter");
  assert.equal(typeof lib.depcruiserAdapter, "object", "нет depcruiserAdapter");
  assert.equal(typeof lib.depcruiserDelta, "function", "нет depcruiserDelta");
  assert.equal(typeof lib.adapterSignature, "function", "нет adapterSignature");
  assert.equal(typeof lib.adapterVersions, "function", "нет adapterVersions");
});

test("ключ кэша: смена состава/версии адаптеров меняет ключ (R4)", () => {
  const BASE = {
    head: "0123456789abcdef0123456789abcdef01234567",
    mtimes: [{ path: "src/a.ts", mtimeMs: 1700000000000 }],
    toolchainVersion: "18.7.0",
    configHashes: { stacks: "abc" },
    packageVersion: "0.1.0",
    parser: "tsc-config",
  };
  const both = "depcruiser:18.7.0:100|git:1.0.0:150";
  const noGit = "depcruiser:18.7.0:100";
  const otherVersion = "depcruiser:18.7.1:100|git:1.0.0:150";
  const a = lib.buildCacheKey({ ...BASE, adapterSignature: both });
  const b = lib.buildCacheKey({ ...BASE, adapterSignature: noGit });
  const c = lib.buildCacheKey({ ...BASE, adapterSignature: otherVersion });
  const d = lib.buildCacheKey({ ...BASE, adapterSignature: both });
  assert.match(a, /^[0-9a-f]{64}$/);
  assert.notEqual(a, b, "смена состава адаптеров должна менять ключ");
  assert.notEqual(a, c, "смена версии адаптера должна менять ключ");
  assert.equal(a, d, "одинаковый состав → одинаковый ключ");
});

test("index.adapters динамический: одна регистрация заглушки → запись в index", () => {
  lib.registerAdapter(stub("wire-dyn", 10));
  const idx = lib.buildIndexBlock({
    gitAvailable: true,
    depcruiseStatus: "ok",
    depcruiseVersion: "18.7.0",
    filesSeen: 10,
    parsed: 10,
    unsupported: [],
    graphEmpty: false,
  });
  const names = idx.adapters.map((a) => a.name);
  assert.deepEqual(names.slice(0, 2), ["scip", "git"], `builtin первыми по priority: ${names}`);
  assert.ok(names.includes("wire-dyn"), `заглушка не попала в index.adapters: ${names}`);
  const entry = idx.adapters.find((a) => a.name === "wire-dyn");
  assert.equal(entry.version, "9.9.9", "версия берётся из реестра");
  assert.equal(idx.state, "ready", "статус по умолчанию ok → index не ломается");
  assert.deepEqual(idx.missing, []);
});

test("index: недоступный/падающий адаптер → missing[] и partial, ядро не падает", () => {
  lib.registerAdapter(stub("wire-gone", 9));
  const base = {
    gitAvailable: true,
    depcruiseStatus: "ok",
    depcruiseVersion: "18.7.0",
    filesSeen: 10,
    parsed: 10,
    unsupported: [],
    graphEmpty: false,
  };
  const gone = lib.buildIndexBlock({ ...base, adapterStatuses: { "wire-gone": { status: "not_available", version: null } } });
  assert.equal(gone.state, "partial", "недоступный адаптер → partial");
  assert.deepEqual(gone.missing, ["wire-gone"]);
  const broken = lib.buildIndexBlock({ ...base, adapterStatuses: { "wire-gone": { status: "error", version: null } } });
  assert.equal(broken.state, "partial", "падающий адаптер → partial");
  assert.deepEqual(broken.missing, ["wire-gone"]);
  assert.deepEqual(broken.adapters.map((a) => a.name).slice(0, 2), ["scip", "git"], "ядро продолжает отвечать");
});

test("runTool с падающим адаптером: ok=true, адаптер в missing[], ядро живо", async () => {
  lib.registerAdapter({
    id: "wire-boom",
    version: "0.0.1",
    license: "MIT",
    precision: "syntax",
    priority: 1,
    detect: async () => [{ id: "wire-boom", confidence: "syntax" }],
    scan: async function* () {
      throw new Error("boom");
    },
  });
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const cache = mkdtempSync(join(tmpdir(), "arch-mcp-wirecache-"));
  const o = { env: { ...process.env, ARCH_MCP_CACHE_DIR: cache }, cwd: ROOT };
  try {
    // Прогрев (ТЗ v3, п.A): холодный arch_status отдаёт building и не ждёт
    // сборку — поллинг до готовности, затем проверяем индекс.
    let ctx;
    for (let i = 0; i < 900; i++) {
      ctx = await lib.runTool("arch_status", { workspace: ROOT }, o);
      if (ctx.payload.index.state !== "building") break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    const env = ctx.payload;
    assert.equal(env.ok, true, "ядро не упало");
    const names = env.index.adapters.map((a) => a.name);
    assert.ok(names.includes("wire-boom"), `нет wire-boom: ${names}`);
    assert.ok(env.index.missing.includes("wire-boom"), `нет в missing: ${JSON.stringify(env.index.missing)}`);
    assert.equal(env.index.state, "partial");
  } finally {
    rmSync(cache, { recursive: true, force: true });
  }
});

test("git-адаптер: R3 — scan даёт пустую дельту, detect уважает capabilities", async () => {
  assert.ok(lib.gitAdapter, "нет gitAdapter в dist/lib.mjs");
  const g = lib.gitAdapter;
  assert.equal(g.id, "git");
  assert.equal(g.license, "MIT");
  const ctx = { root: "E:/x", roots: ["E:/x"], gitHead: null, files: [], capabilities: [], cacheDir: "", timeoutMs: 1, maxBytes: 1 };
  assert.deepEqual(await g.detect(ctx), [], "без capabilities git недоступен");
  const caps = await g.detect({ ...ctx, capabilities: [{ id: "git", confidence: "manifest" }] });
  assert.equal(caps.length, 1, "с capabilities — capability есть");
  const deltas = [];
  for await (const d of g.scan({ ...ctx, capabilities: caps })) deltas.push(d);
  assert.deepEqual(deltas, [], "R3: git граф не даёт — scan пустой");
});

test("depcruiser-адаптер: метаданные и дельта из raw (fixture: 226 узлов, 189 рёбер)", () => {
  assert.ok(lib.depcruiserAdapter, "нет depcruiserAdapter в dist/lib.mjs");
  const d = lib.depcruiserAdapter;
  assert.equal(d.id, "depcruiser");
  assert.equal(d.priority, 100, "priority 100");
  assert.equal(d.license, "MIT");
  assert.equal(typeof d.version, "string");
  assert.ok(d.version.length > 0, "version из toolchain");
  const raw = JSON.parse(readFileSync(FIXTURE, "utf8"));
  const delta = lib.depcruiserDelta(raw);
  assert.equal(delta.nodes.length, 226, "module-узлы");
  assert.ok(delta.nodes.every((n) => n.kind === "module"), "kind=module");
  assert.ok(delta.nodes.every((n) => !/^[a-zA-Z]:/.test(n.id) && !n.id.includes("\\")), "id — repo-relative POSIX (R1)");
  assert.equal(delta.edges.length, 189, "imports-рёбра");
  const e = delta.edges[0];
  assert.equal(e.kind, "imports");
  assert.ok(Array.isArray(e.meta.dependencyTypes), "meta.dependencyTypes");
  assert.equal(typeof e.meta.type_only, "boolean", "meta.type_only");
  assert.equal(delta.coverage.files_seen, lib.moduleCount(raw), "files_seen = число модулей");
});
