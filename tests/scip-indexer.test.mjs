// Тест-план scip-indexer (ТЗ v6; врата specreviewer круг 6 — журнал:9628):
//  1) нет эталона + шаблон + ALLOW_EXEC=1 → спавн ровно 1 (node <stub>.mjs),
//     подстановка {root}/{out}, cwd=root, run-индекс прочитан → symbol+references,
//     run-каталог удалён;
//  2) эталонный индекс есть → спавнов по индексу 0;
//  3) кэш-хит → спавнов 0;
//  4) шаблон + ALLOW_EXEC=0 → спавнов 0, scip absent (нет в index.adapters);
//  5) exit≠0 → not_available + reason в index.adapters[scip], граф-статус/evidence
//     core (dependency-cruiser), strict focus отвечает, run-каталог удалён;
//  5б) повтор после сбоя (кэш-хит) → спавнов 0, reason сохраняется;
//  6) таймаут → reason содержит ARCH_MCP_TIMEOUT_MS, run-каталог удалён;
//  7) .cmd первым токеном → reason «.cmd/.bat unsupported», спавнов 0;
//  8) незакрытая кавычка → reason «unterminated quote», спавнов 0;
//  9) ключ кэша: режим 0/1 при одном шаблоне и разные шаблоны → разные хэши;
// 10) нормализатор диапазонов (а–ж): legacy 3-int → references+edge.line,
//     legacy 4-int multi → containment, typed single, typed multi в одну строку
//     (MUST accept), typed multi многострочный (edge.line=startLine+1),
//     typed приоритетнее legacy, range длины 2 → игнор;
// 11) process.env ≠ ctx.config → поведение по ctx.config;
// 12) битый эталон → FullGraph.status/evidence — core, scip в adapters/missing,
//     strict focus отвечает; CORE_ADAPTER_IDS реэкспортирован;
// 13) смена исходника → новый ключ кэша → перегенерация (спавн 1).
//
// RED до прод-кода: проверки падают на текущем dist/lib.mjs (см. writer-report).
import assert from "node:assert/strict";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, sep } from "node:path";
import { test } from "node:test";
import { create, toBinary } from "@bufbuild/protobuf";
import { IndexSchema, DocumentSchema, OccurrenceSchema, SymbolRole } from "@scip-code/scip";
import * as lib from "../dist/lib.mjs";

// Изоляция кэша графа: слой кэша читает ARCH_MCP_CACHE_DIR из process.env.
const CACHE = mkdtempSync(join(tmpdir(), "arch-mcp-scipidx-cache-"));
const PREV_CACHE = process.env.ARCH_MCP_CACHE_DIR;
process.env.ARCH_MCP_CACHE_DIR = CACHE;

const SCIP_ID = "scip";
const RUN_DIR_RE = /^run-\d+-\d+$/;
const INDEXER_KEY = "node scip-stub.mjs";
const FAIL_KEY = "node fail-stub.mjs";

const norm = (p) => String(p).replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function baseEnv(extra = {}) {
  const env = { ...process.env, ARCH_MCP_CACHE_DIR: CACHE };
  delete env.ARCH_MCP_ALLOW_EXEC;
  delete env.ARCH_MCP_SCIP_INDEXER;
  delete env.ARCH_MCP_SCIP_DIR;
  return { ...env, ...extra };
}

function makeWs() {
  const ws = mkdtempSync(join(tmpdir(), "arch-mcp-scipidx-ws-"));
  mkdirSync(join(ws, "src"), { recursive: true });
  writeFileSync(join(ws, "package.json"), JSON.stringify({ name: "scipidx-fixture", version: "1.0.0", type: "module" }), "utf8");
  writeFileSync(join(ws, "src", "a.ts"), "export const a = 1;\n", "utf8");
  writeFileSync(join(ws, "src", "b.ts"), 'import { a } from "./a.ts";\nexport const b = a;\n', "utf8");
  return ws;
}

/** Поллинг arch_status до выхода из building (как в robustness.test.mjs). */
async function waitBuilt(run, name, args, o) {
  const deadline = Date.now() + 120_000;
  for (;;) {
    const ctx = await run(name, args, o);
    if (ctx.payload.index.state !== "building") return { ctx };
    if (Date.now() > deadline) throw new Error("index building не завершился за 120 с");
    await sleep(100);
  }
}

function runDirs(root) {
  const dir = join(lib.repoCacheDir(root), "scip");
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((n) => RUN_DIR_RE.test(n));
}

function scipAdapter() {
  const found = lib.builtinAdapters().find((a) => a.id === SCIP_ID);
  assert.ok(found, `нет адаптера ${SCIP_ID}`);
  return found;
}

// ---------- фикстуры .scip через toBinary (@bufbuild/protobuf) ----------

function occTyped(symbol, roles, line, start, end) {
  return create(OccurrenceSchema, {
    symbol,
    symbolRoles: roles,
    typedRange: { case: "singleLineRange", value: { line, startCharacter: start, endCharacter: end } },
  });
}

function occLegacy(symbol, roles, range) {
  return create(OccurrenceSchema, { symbol, symbolRoles: roles, range });
}

function occTypedMulti(symbol, roles, startLine, startCharacter, endLine, endCharacter) {
  return create(OccurrenceSchema, {
    symbol,
    symbolRoles: roles,
    typedRange: { case: "multiLineRange", value: { startLine, startCharacter, endLine, endCharacter } },
  });
}

function doc(relativePath, occurrences) {
  return create(DocumentSchema, { relativePath, occurrences });
}

function stdDocs() {
  return [
    doc("src/main.go", [
      occTyped("example/main.main#", SymbolRole.Definition, 0, 0, 4),
      occTyped("example/helper.run#", 0, 2, 4, 7),
    ]),
    doc("src/helper.go", [occTyped("example/helper.run#", SymbolRole.Definition, 0, 0, 3)]),
  ];
}

function writeScipIndex(dir, documents) {
  mkdirSync(dir, { recursive: true });
  const index = create(IndexSchema, {
    metadata: { toolInfo: { name: "scip-indexer-test", version: "0.0.1" }, projectRoot: "file:///repo/" },
    documents,
  });
  writeFileSync(join(dir, "index.scip"), toBinary(IndexSchema, index));
}

function scanCtx(root, config) {
  return {
    root,
    roots: [root],
    gitHead: null,
    files: [],
    capabilities: [{ id: SCIP_ID, confidence: "semantic" }],
    cacheDir: lib.repoCacheDir(root),
    timeoutMs: 60_000,
    maxBytes: 1_048_576,
    config,
  };
}

// ---------- заглушки-индексеры (Node-скрипты во временном каталоге) ----------

const STUB_DIR = mkdtempSync(join(tmpdir(), "arch-mcp-scipidx-stub-"));
const STUB = join(STUB_DIR, "scip-stub.mjs");
const FAIL_STUB = join(STUB_DIR, "fail-stub.mjs");
const SLEEP_STUB = join(STUB_DIR, "sleep-stub.mjs");
const FIXTURE = join(STUB_DIR, "fixture.scip");

writeFileSync(
  STUB,
  [
    'import { copyFileSync, writeFileSync } from "node:fs";',
    "const [probe, rootArg, outArg, src] = process.argv.slice(2);",
    'writeFileSync(probe, JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd() }));',
    'copyFileSync(src, outArg + "/index.scip");',
    "",
  ].join("\n"),
  "utf8",
);
writeFileSync(FAIL_STUB, 'console.error("boom: indexer exploded");\nprocess.exit(1);\n', "utf8");
writeFileSync(SLEEP_STUB, "setTimeout(() => {}, 8000);\n", "utf8");
writeScipIndex(STUB_DIR, stdDocs());
// writeScipIndex кладёт index.scip — фикстура-источник для заглушки:
const FIXTURE_INDEX = join(STUB_DIR, "index.scip");

const PROBE1 = join(STUB_DIR, "probe1.json");
const TEMPLATE1 = `node "${STUB}" "${PROBE1}" "{root}" "{out}" "${FIXTURE_INDEX}"`;

let wsMain = null;
let envMain = null;
let wsFail = null;
let envFail = null;

test.after(() => {
  for (const dir of [wsMain, wsFail]) if (dir !== null) rmSync(dir, { recursive: true, force: true });
  if (PREV_CACHE === undefined) delete process.env.ARCH_MCP_CACHE_DIR;
  else process.env.ARCH_MCP_CACHE_DIR = PREV_CACHE;
  rmSync(CACHE, { recursive: true, force: true });
  rmSync(STUB_DIR, { recursive: true, force: true });
});

test("1) нет эталона + шаблон + ALLOW_EXEC=1: спавн 1, подстановка {root}/{out}, cwd=root, run-индекс прочитан", async () => {
  wsMain = makeWs();
  envMain = baseEnv({ ARCH_MCP_ALLOW_EXEC: "1", ARCH_MCP_SCIP_INDEXER: TEMPLATE1 });
  const o = { env: envMain, cwd: wsMain };
  lib.resetSpawnStats();
  const { ctx } = await waitBuilt(lib.runTool, "arch_status", { workspace: wsMain }, o);
  const p = ctx.payload;
  assert.ok(["ready", "partial"].includes(p.index.state), `state=${p.index.state}`);

  assert.equal(
    lib.spawnStats.byCommand[INDEXER_KEY] ?? 0,
    1,
    `спавнов индексера ${lib.spawnStats.byCommand[INDEXER_KEY] ?? 0}, ожидался 1: ${JSON.stringify(lib.spawnStats.byCommand)}`,
  );

  const probe = JSON.parse(readFileSync(PROBE1, "utf8"));
  assert.equal(norm(probe.cwd), norm(wsMain), `cwd=${probe.cwd}, root=${wsMain}`);
  assert.equal(norm(probe.argv[1]), norm(wsMain), `argv root=${probe.argv[1]}`);
  const outArg = probe.argv[2];
  assert.match(basename(String(outArg)), RUN_DIR_RE, `out-токен не run-каталог: ${outArg}`);
  const expectedPrefix = join(lib.repoCacheDir(wsMain), "scip") + sep;
  assert.ok(String(outArg).startsWith(expectedPrefix), `out=${outArg}, префикс=${expectedPrefix}`);

  // Прочитан run-индекс → symbol-узлы и references-ребро.
  const full = await lib.loadFullGraph(wsMain, lib.loadConfig(envMain));
  assert.ok(full.graph.nodes.includes("symbol:src/main.go#main"), `нет symbol main: ${JSON.stringify(full.graph.nodes.slice(0, 30))}`);
  assert.ok(full.graph.nodes.includes("symbol:src/helper.go#run"), `нет symbol run: ${JSON.stringify(full.graph.nodes.slice(0, 30))}`);
  assert.ok(
    full.graph.edges.some((e) => e.source === "symbol:src/main.go#main" && e.target === "symbol:src/helper.go#run"),
    `нет references-ребра: ${JSON.stringify(full.graph.edges.filter((e) => String(e.source).startsWith("symbol:")).slice(0, 5))}`,
  );
  assert.deepEqual(runDirs(wsMain), [], "run-каталог должен быть удалён после чтения");
});

test("2) эталонный индекс есть → спавнов по индексу 0, эталон прочитан", async () => {
  const ws2 = makeWs();
  try {
    writeScipIndex(join(ws2, ".arch", "scip"), stdDocs());
    const env = baseEnv({ ARCH_MCP_ALLOW_EXEC: "1", ARCH_MCP_SCIP_INDEXER: TEMPLATE1 });
    lib.resetSpawnStats();
    await waitBuilt(lib.runTool, "arch_status", { workspace: ws2 }, { env, cwd: ws2 });
    assert.equal(
      lib.spawnStats.byCommand[INDEXER_KEY] ?? 0,
      0,
      `спавнов ${lib.spawnStats.byCommand[INDEXER_KEY] ?? 0}, ожидался 0: ${JSON.stringify(lib.spawnStats.byCommand)}`,
    );
    const full = await lib.loadFullGraph(ws2, lib.loadConfig(env));
    assert.ok(full.graph.nodes.includes("symbol:src/main.go#main"), "эталонный индекс не прочитан");
    assert.deepEqual(runDirs(ws2), [], "run-каталогов быть не должно");
  } finally {
    rmSync(ws2, { recursive: true, force: true });
  }
});

test("3) кэш-хит → спавнов по индексу 0", async () => {
  assert.ok(wsMain, "workspace кейса 1 не создан");
  lib.resetSpawnStats();
  const ctx = await lib.runTool("arch_status", { workspace: wsMain }, { env: envMain, cwd: wsMain });
  assert.equal(ctx.cached, true, `cached=${ctx.cached}, ожидался кэш-хит`);
  assert.equal(
    lib.spawnStats.byCommand[INDEXER_KEY] ?? 0,
    0,
    `спавнов ${lib.spawnStats.byCommand[INDEXER_KEY] ?? 0}, ожидался 0: ${JSON.stringify(lib.spawnStats.byCommand)}`,
  );
});

test("4) шаблон + ALLOW_EXEC=0 → спавнов 0, scip absent (нет в index.adapters)", async () => {
  const ws4 = makeWs();
  try {
    const env = baseEnv({ ARCH_MCP_SCIP_INDEXER: TEMPLATE1 });
    lib.resetSpawnStats();
    const { ctx } = await waitBuilt(lib.runTool, "arch_status", { workspace: ws4 }, { env, cwd: ws4 });
    const p = ctx.payload;
    assert.equal(
      lib.spawnStats.byCommand[INDEXER_KEY] ?? 0,
      0,
      `спавнов ${lib.spawnStats.byCommand[INDEXER_KEY] ?? 0}, ожидался 0: ${JSON.stringify(lib.spawnStats.byCommand)}`,
    );
    assert.ok(!p.index.adapters.some((a) => a.name === SCIP_ID), `scip в adapters: ${JSON.stringify(p.index.adapters)}`);
    assert.ok(!p.index.missing.includes(SCIP_ID), `scip в missing: ${JSON.stringify(p.index.missing)}`);
  } finally {
    rmSync(ws4, { recursive: true, force: true });
  }
});

test("5) exit≠0 → not_available + reason, граф-статус core, strict отвечает, run-каталог удалён", async () => {
  wsFail = makeWs();
  const probe5 = join(STUB_DIR, "probe5.json");
  const failTemplate = `node "${FAIL_STUB}" "${probe5}" "{root}" "{out}"`;
  envFail = baseEnv({ ARCH_MCP_ALLOW_EXEC: "1", ARCH_MCP_SCIP_INDEXER: failTemplate });
  const o = { env: envFail, cwd: wsFail };
  const { ctx } = await waitBuilt(lib.runTool, "arch_status", { workspace: wsFail }, o);
  const p = ctx.payload;

  const entry = p.index.adapters.find((a) => a.name === SCIP_ID);
  assert.ok(entry, `scip нет в index.adapters: ${JSON.stringify(p.index.adapters)}`);
  assert.equal(entry.status, "not_available", `scip status=${entry.status}`);
  assert.ok(typeof entry.reason === "string" && entry.reason.length > 0, `reason отсутствует: ${JSON.stringify(entry)}`);
  assert.ok(entry.reason.length <= 200, `reason длиннее 200: ${entry.reason.length}`);
  assert.match(entry.reason, /scip indexer/, `reason=${entry.reason}`);
  assert.ok(entry.reason.includes("boom"), `в reason нет хвоста stderr: ${entry.reason}`);
  assert.ok(p.index.missing.includes(SCIP_ID), `scip не в missing: ${JSON.stringify(p.index.missing)}`);

  const full = await lib.loadFullGraph(wsFail, lib.loadConfig(envFail));
  assert.equal(full.status, "ok", `FullGraph.status=${full.status} — ожидается core-статус`);
  assert.match(String(full.evidence.command), /dependency-cruiser/, `evidence не core: ${full.evidence.command}`);

  const focusRes = await lib.runTool("focus", { workspace: wsFail, node: "src/a.ts" }, o);
  assert.equal(focusRes.payload.ok, true, `focus: ${JSON.stringify(focusRes.payload.error ?? {})}`);

  assert.deepEqual(runDirs(wsFail), [], "run-каталог не удалён после сбоя");
});

test("5б) повтор после сбоя (кэш-хит): спавнов 0, reason сохраняется", async () => {
  assert.ok(wsFail, "workspace кейса 5 не создан");
  lib.resetSpawnStats();
  const ctx = await lib.runTool("arch_status", { workspace: wsFail }, { env: envFail, cwd: wsFail });
  assert.equal(ctx.cached, true, `cached=${ctx.cached}, ожидался кэш-хит`);
  assert.equal(
    lib.spawnStats.byCommand[FAIL_KEY] ?? 0,
    0,
    `спавнов ${lib.spawnStats.byCommand[FAIL_KEY] ?? 0}, ожидался 0: ${JSON.stringify(lib.spawnStats.byCommand)}`,
  );
  const entry = ctx.payload.index.adapters.find((a) => a.name === SCIP_ID);
  assert.ok(entry, `scip нет в index.adapters: ${JSON.stringify(ctx.payload.index.adapters)}`);
  assert.equal(entry.status, "not_available", `scip status=${entry.status}`);
  assert.ok(
    typeof entry.reason === "string" && entry.reason.includes("boom"),
    `reason не сохранился из кэша: ${JSON.stringify(entry)}`,
  );
});

test("6) таймаут → reason содержит ARCH_MCP_TIMEOUT_MS, run-каталог удалён", async () => {
  const root6 = mkdtempSync(join(tmpdir(), "arch-mcp-scipidx-timeout-"));
  try {
    const tmpl = `node "${SLEEP_STUB}" "{root}" "{out}"`;
    const cfg = lib.loadConfig({ ARCH_MCP_ALLOW_EXEC: "1", ARCH_MCP_SCIP_INDEXER: tmpl, ARCH_MCP_TIMEOUT_MS: "1500" });
    const ctx = scanCtx(root6, cfg);
    ctx.timeoutMs = 1500;
    const run = await lib.runAdapter(scipAdapter(), ctx);
    assert.equal(run.status, "not_available", `status=${run.status} evidence=${JSON.stringify(run.evidence)}`);
    const reason = String(run.evidence?.reason ?? "");
    assert.match(reason, /ARCH_MCP_TIMEOUT_MS/, `reason=${reason}`);
    assert.deepEqual(runDirs(root6), [], "run-каталог не удалён после таймаута");
  } finally {
    rmSync(root6, { recursive: true, force: true });
  }
});

test("7) .cmd первым токеном → reason «.cmd/.bat unsupported», спавнов 0", async () => {
  const root7 = mkdtempSync(join(tmpdir(), "arch-mcp-scipidx-cmd-"));
  try {
    const cfg = lib.loadConfig({
      ARCH_MCP_ALLOW_EXEC: "1",
      ARCH_MCP_SCIP_INDEXER: "C:\\tools\\indexer.cmd {root} {out}",
    });
    lib.resetSpawnStats();
    const run = await lib.runAdapter(scipAdapter(), scanCtx(root7, cfg));
    assert.equal(run.status, "not_available", `status=${run.status}`);
    const reason = String(run.evidence?.reason ?? "");
    assert.match(reason, /\.cmd\/\.bat unsupported/, `reason=${reason}`);
    assert.deepEqual(lib.spawnStats.byCommand, {}, `спавнов быть не должно: ${JSON.stringify(lib.spawnStats.byCommand)}`);
  } finally {
    rmSync(root7, { recursive: true, force: true });
  }
});

test("8) незакрытая кавычка → reason «unterminated quote», спавнов 0", async () => {
  const root8 = mkdtempSync(join(tmpdir(), "arch-mcp-scipidx-quote-"));
  try {
    const cfg = lib.loadConfig({
      ARCH_MCP_ALLOW_EXEC: "1",
      ARCH_MCP_SCIP_INDEXER: 'node "C:\\broken\\file.mjs {root}',
    });
    lib.resetSpawnStats();
    const run = await lib.runAdapter(scipAdapter(), scanCtx(root8, cfg));
    assert.equal(run.status, "not_available", `status=${run.status}`);
    const reason = String(run.evidence?.reason ?? "");
    assert.match(reason, /unterminated quote/, `reason=${reason}`);
    assert.deepEqual(lib.spawnStats.byCommand, {}, `спавнов быть не должно: ${JSON.stringify(lib.spawnStats.byCommand)}`);
  } finally {
    rmSync(root8, { recursive: true, force: true });
  }
});

test("9) ключ кэша: режим 0/1 при одном шаблоне и разные шаблоны → разные хэши", () => {
  const onA = lib.loadConfig({ ARCH_MCP_SCIP_INDEXER: "node a.mjs {root}", ARCH_MCP_ALLOW_EXEC: "1" });
  const onB = lib.loadConfig({ ARCH_MCP_SCIP_INDEXER: "node b.mjs {root}", ARCH_MCP_ALLOW_EXEC: "1" });
  const offA = lib.loadConfig({ ARCH_MCP_SCIP_INDEXER: "node a.mjs {root}" });
  const hA = lib.configHashes(onA);
  const hB = lib.configHashes(onB);
  const hOff = lib.configHashes(offA);
  assert.ok(typeof hA.scipIndexer === "string" && hA.scipIndexer.length > 0, `scipIndexer в configHashes: ${JSON.stringify(hA)}`);
  assert.ok(typeof hA.scipIndexerMode === "string" && hA.scipIndexerMode.length > 0, `scipIndexerMode в configHashes: ${JSON.stringify(hA)}`);
  assert.notEqual(hA.scipIndexerMode, hOff.scipIndexerMode, "режим 0/1 при одном шаблоне даст одинаковый хэш");
  assert.notEqual(hA.scipIndexer, hB.scipIndexer, "разные шаблоны дали одинаковый хэш");
  const hA2 = lib.configHashes(lib.loadConfig({ ARCH_MCP_SCIP_INDEXER: "node a.mjs {root}", ARCH_MCP_ALLOW_EXEC: "1" }));
  assert.equal(hA.scipIndexer, hA2.scipIndexer, "одинаковый шаблон дал разные хэши");
  assert.equal(hA.scipIndexerMode, hA2.scipIndexerMode, "одинаковый режим дал разные хэши");
});

test("10) нормализатор диапазонов (а–ж): legacy/typed, containment, приоритет, длина 2", async () => {
  const root = mkdtempSync(join(tmpdir(), "arch-mcp-scipidx-ranges-"));
  try {
    const DEF_D = "local/D#";
    const DEF_E = "local/E#";
    const REF = "ext/X#";
    const SRC = "symbol:src/a.go#D";
    const TGT = "symbol:src/b.go#X";
    const cfg = lib.loadConfig({ ARCH_MCP_SCIP_DIR: join(root, "idx") });

    /** doc a.go: два определения (D и E) — fallback «единственное определение» исключён. */
    const runCase = async (defD, refOcc) => {
      const idxDir = join(root, "idx");
      rmSync(idxDir, { recursive: true, force: true });
      writeScipIndex(idxDir, [
        doc("src/a.go", [defD, occTyped(DEF_E, SymbolRole.Definition, 9, 0, 10), refOcc]),
        doc("src/b.go", [occTyped(REF, SymbolRole.Definition, 0, 0, 3)]),
      ]);
      const run = await lib.runAdapter(scipAdapter(), scanCtx(root, cfg));
      assert.equal(run.status, "ok", `status=${run.status} evidence=${JSON.stringify(run.evidence)}`);
      return run.deltas[0].edges.filter((e) => e.kind === "references");
    };

    // (а) legacy 3-int → references + edge.line
    let refs = await runCase(
      occTyped(DEF_D, SymbolRole.Definition, 1, 0, 10),
      occLegacy(REF, 0, [1, 2, 5]),
    );
    assert.equal(refs.length, 1, `(а) references: ${JSON.stringify(refs)}`);
    assert.equal(refs[0].source, SRC, `(а) source=${refs[0].source}`);
    assert.equal(refs[0].target, TGT, `(а) target=${refs[0].target}`);
    assert.equal(refs[0].line, 2, `(а) line=${refs[0].line} (ожидалась startLine+1=2)`);

    // (б) legacy 4-int multi у определения → containment по (line,char) half-open
    refs = await runCase(
      occLegacy(DEF_D, SymbolRole.Definition, [0, 0, 3, 4]),
      occLegacy(REF, 0, [2, 0, 5]),
    );
    assert.equal(refs.length, 1, `(б) references: ${JSON.stringify(refs)}`);
    assert.equal(refs[0].source, SRC, `(б) source=${refs[0].source}`);
    assert.equal(refs[0].line, 3, `(б) line=${refs[0].line} (ожидалась 2+1=3)`);

    // (в) typed single работает
    refs = await runCase(
      occTyped(DEF_D, SymbolRole.Definition, 1, 0, 10),
      occTyped(REF, 0, 1, 0, 5),
    );
    assert.equal(refs.length, 1, `(в) references: ${JSON.stringify(refs)}`);
    assert.equal(refs[0].line, 2, `(в) line=${refs[0].line}`);

    // (г) typed multi, укладывающийся в одну строку → MUST accept
    refs = await runCase(
      occTyped(DEF_D, SymbolRole.Definition, 1, 0, 10),
      occTypedMulti(REF, 0, 1, 2, 1, 8),
    );
    assert.equal(refs.length, 1, `(г) typed multi в одну строку должен приниматься: ${JSON.stringify(refs)}`);
    assert.equal(refs[0].line, 2, `(г) line=${refs[0].line}`);

    // (д) typed multi многострочный → reference во второй строке, edge.line=startLine+1
    refs = await runCase(
      occTypedMulti(DEF_D, SymbolRole.Definition, 0, 0, 3, 0),
      occTypedMulti(REF, 0, 1, 0, 2, 5),
    );
    assert.equal(refs.length, 1, `(д) references: ${JSON.stringify(refs)}`);
    assert.equal(refs[0].source, SRC, `(д) source=${refs[0].source}`);
    assert.equal(refs[0].line, 2, `(д) line=${refs[0].line} (ожидалась startLine+1=1+1)`);

    // (е) typed приоритетнее legacy при конфликте: typed=строка 1 → source D, line 2
    const conflicted = create(OccurrenceSchema, {
      symbol: REF,
      symbolRoles: 0,
      typedRange: { case: "singleLineRange", value: { line: 1, startCharacter: 0, endCharacter: 5 } },
      range: [9, 0, 9],
    });
    refs = await runCase(occTyped(DEF_D, SymbolRole.Definition, 1, 0, 10), conflicted);
    assert.equal(refs.length, 1, `(е) references: ${JSON.stringify(refs)}`);
    assert.equal(refs[0].source, SRC, `(е) typed не победил legacy: source=${refs[0].source}`);
    assert.equal(refs[0].line, 2, `(е) line=${refs[0].line}`);

    // (ж) range длины 2 → игнор (2 определения → ребра нет)
    refs = await runCase(occTyped(DEF_D, SymbolRole.Definition, 1, 0, 10), occLegacy(REF, 0, [1, 2]));
    assert.deepEqual(refs, [], `(ж) range длины 2 должен игнорироваться: ${JSON.stringify(refs)}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("11) process.env ≠ ctx.config → поведение по ctx.config", async () => {
  const saved = {
    dir: process.env.ARCH_MCP_SCIP_DIR,
    exec: process.env.ARCH_MCP_ALLOW_EXEC,
    indexer: process.env.ARCH_MCP_SCIP_INDEXER,
  };
  try {
    // (а) env указывает в несуществующий каталог, ctx.config — в эталонный индекс.
    const root11 = mkdtempSync(join(tmpdir(), "arch-mcp-scipidx-cfg-"));
    const fixtureDir = join(STUB_DIR, "cfg-fixture");
    writeScipIndex(fixtureDir, stdDocs());
    process.env.ARCH_MCP_SCIP_DIR = "C:\\bogus\\scip-dir-does-not-exist";
    delete process.env.ARCH_MCP_ALLOW_EXEC;
    delete process.env.ARCH_MCP_SCIP_INDEXER;
    lib.resetSpawnStats();
    const cfgA = lib.loadConfig({ ARCH_MCP_SCIP_DIR: fixtureDir });
    const runA = await lib.runAdapter(scipAdapter(), scanCtx(root11, cfgA));
    assert.equal(runA.status, "ok", `(а) status=${runA.status} evidence=${JSON.stringify(runA.evidence)}`);
    assert.equal(
      lib.spawnStats.byCommand[INDEXER_KEY] ?? 0,
      0,
      `(а) спавнов ${lib.spawnStats.byCommand[INDEXER_KEY] ?? 0}, ожидался 0 (эталон из ctx.config)`,
    );

    // (б) env без флага/шаблона, ctx.config с флагом и шаблоном → индексер запускается.
    const root11b = mkdtempSync(join(tmpdir(), "arch-mcp-scipidx-cfgb-"));
    const probeB = join(STUB_DIR, "probe11b.json");
    const tmplB = `node "${STUB}" "${probeB}" "{root}" "{out}" "${FIXTURE_INDEX}"`;
    const cfgB = lib.loadConfig({ ARCH_MCP_ALLOW_EXEC: "1", ARCH_MCP_SCIP_INDEXER: tmplB });
    lib.resetSpawnStats();
    const runB = await lib.runAdapter(scipAdapter(), scanCtx(root11b, cfgB));
    assert.equal(runB.status, "ok", `(б) status=${runB.status} evidence=${JSON.stringify(runB.evidence)}`);
    assert.equal(
      lib.spawnStats.byCommand[INDEXER_KEY] ?? 0,
      1,
      `(б) спавнов ${lib.spawnStats.byCommand[INDEXER_KEY] ?? 0}, ожидался 1 (ctx.config, не process.env): ${JSON.stringify(lib.spawnStats.byCommand)}`,
    );
    assert.ok(existsSync(probeB), "(б) заглушка не отработала по ctx.config");
    rmSync(root11, { recursive: true, force: true });
    rmSync(root11b, { recursive: true, force: true });
  } finally {
    if (saved.dir === undefined) delete process.env.ARCH_MCP_SCIP_DIR;
    else process.env.ARCH_MCP_SCIP_DIR = saved.dir;
    if (saved.exec === undefined) delete process.env.ARCH_MCP_ALLOW_EXEC;
    else process.env.ARCH_MCP_ALLOW_EXEC = saved.exec;
    if (saved.indexer === undefined) delete process.env.ARCH_MCP_SCIP_INDEXER;
    else process.env.ARCH_MCP_SCIP_INDEXER = saved.indexer;
  }
});

test("12) битый эталон → статус/evidence core, scip в adapters/missing, focus отвечает, CORE_ADAPTER_IDS", async () => {
  assert.ok(Array.isArray(lib.CORE_ADAPTER_IDS), `CORE_ADAPTER_IDS не реэкспортирован из dist/lib.mjs: ${String(lib.CORE_ADAPTER_IDS)}`);
  assert.deepEqual([...lib.CORE_ADAPTER_IDS].sort(), ["depcruiser", "git"], `CORE_ADAPTER_IDS=${JSON.stringify(lib.CORE_ADAPTER_IDS)}`);

  const ws12 = makeWs();
  try {
    const idxDir = join(ws12, ".arch", "scip");
    mkdirSync(idxDir, { recursive: true });
    writeFileSync(join(idxDir, "index.scip"), Buffer.from("not-a-scip-index", "utf8"));
    const env = baseEnv({});
    const o = { env, cwd: ws12 };
    const { ctx } = await waitBuilt(lib.runTool, "arch_status", { workspace: ws12 }, o);
    const p = ctx.payload;

    const entry = p.index.adapters.find((a) => a.name === SCIP_ID);
    assert.ok(entry, `scip нет в index.adapters: ${JSON.stringify(p.index.adapters)}`);
    assert.equal(entry.status, "not_available", `scip status=${entry.status}`);
    assert.ok(typeof entry.reason === "string" && entry.reason.length > 0, `reason отсутствует: ${JSON.stringify(entry)}`);
    assert.ok(p.index.missing.includes(SCIP_ID), `scip не в missing: ${JSON.stringify(p.index.missing)}`);

    const full = await lib.loadFullGraph(ws12, lib.loadConfig(env));
    assert.equal(full.status, "ok", `FullGraph.status=${full.status} — битый scip не должен перехватывать статус core`);
    assert.match(String(full.evidence.command), /dependency-cruiser/, `evidence не core: ${full.evidence.command}`);

    const focusRes = await lib.runTool("focus", { workspace: ws12, node: "src/a.ts" }, o);
    assert.equal(focusRes.payload.ok, true, `focus: ${JSON.stringify(focusRes.payload.error ?? {})}`);
  } finally {
    rmSync(ws12, { recursive: true, force: true });
  }
});

test("13) смена исходника → новый ключ кэша → перегенерация (спавн 1)", async () => {
  assert.ok(wsMain, "workspace кейса 1 не создан");
  const o = { env: envMain, cwd: wsMain };
  const before = await lib.runTool("arch_status", { workspace: wsMain }, o);
  assert.equal(before.cached, true, `предусловие: cached=${before.cached}`);

  appendFileSync(join(wsMain, "src", "a.ts"), "// touched by scip-indexer test\n");
  lib.resetSpawnStats();
  // Наблюдаемость «новый ключ»: пересборка (ТЗ 13) — факт повторного запуска
  // индексера; arch_status отдаёт готовую запись с cached=true и это нормально.
  const { ctx } = await waitBuilt(lib.runTool, "arch_status", { workspace: wsMain }, o);
  assert.ok(["ready", "partial"].includes(ctx.payload.index.state), `state=${ctx.payload.index.state}`);
  assert.equal(
    lib.spawnStats.byCommand[INDEXER_KEY] ?? 0,
    1,
    `спавнов ${lib.spawnStats.byCommand[INDEXER_KEY] ?? 0}, ожидалась перегенерация (1): ${JSON.stringify(lib.spawnStats.byCommand)}`,
  );
  assert.deepEqual(runDirs(wsMain), [], "run-каталог должен быть удалён после чтения");
});
