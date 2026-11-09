// Тест-план robustness (ТЗ v3, врата journal:9322):
//  1) холодный arch_status не ждёт сборку → building-конверт ≤3 с;
//  2) после фонового завершения повторный arch_status → ready/partial + cached,
//     фоновый прогон ровно один (счётчик registerAdapter);
//  3) focus строгий: ждёт идущий фоновый прогон и отвечает; параллельные
//     focus — single-flight (второй прогон не стартует);
//  4) деградация core (depcruiser timeout): запись degraded{reason,ts},
//     повтор в пределах TTL без пересбора, после TTL (правка degraded.ts
//     в файле кэш-записи, без sleep) — пересбор;
//  5) optional not_available при core ok: FullGraph.status/evidence — core,
//     missing[] содержит элемент, state=partial, focus отвечает, запись НЕ degraded;
//  6) кэш-hit на git-workspace: inspectGit ровно 1 вызов за runTool,
//     все runExternal-спавны — только git (≤3: rev-parse/status/log);
//  7) SCHEMA_VERSION=6, GRAPH_SCHEMA_VERSION=graph-9; kinds-инвариант
//     проверяется только вне building.
//
// RED до прод-кода: проверки падают на текущем dist/lib.mjs (см. writer-report).
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
import * as lib from "../dist/lib.mjs";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const ARCH_MCP = "E:\\1_Products\\arch-mcp";

// Изоляция кэша графа: слой кэша читает ARCH_MCP_CACHE_DIR из process.env
// (src/cache.ts: repoCacheDir без env → process.env), поэтому каталог кэша
// ставится в процессе теста один раз и восстанавливается в test.after.
const CACHE = mkdtempSync(join(tmpdir(), "arch-mcp-robust-cache-"));
const PREV_CACHE = process.env.ARCH_MCP_CACHE_DIR;
process.env.ARCH_MCP_CACHE_DIR = CACHE;

// Счётчик фоновых прогонов: адаптер регистрируется один раз на файл теста,
// каждый прогон построения увеличивает счётчик на 1 (шаг ТЗ: registerAdapter).
let counterRuns = 0;
lib.registerAdapter({
  id: "zz-robust-counter",
  version: "1.0.0",
  license: "MIT",
  precision: "syntax",
  priority: 1,
  detect: async () => [],
  scan: async function* () {},
  outcome: async () => {
    counterRuns += 1;
    await sleep(300); // окно для параллельных вызовов
    return { status: "ok", deltas: [] };
  },
});

function makeWs() {
  const ws = mkdtempSync(join(tmpdir(), "arch-mcp-robust-ws-"));
  mkdirSync(join(ws, "src"), { recursive: true });
  writeFileSync(join(ws, "package.json"), JSON.stringify({ name: "robust-fixture", version: "1.0.0", type: "module" }), "utf8");
  writeFileSync(join(ws, "src", "a.ts"), "export const a = 1;\n", "utf8");
  writeFileSync(join(ws, "src", "b.ts"), 'import { a } from "./a.ts";\nexport const b = a;\n', "utf8");
  return ws;
}

/** Поллинг инструмента до выхода из building; settleThrow — ждём ошибку вместо ответа. */
async function waitBuilt(run, name, args, o, { settleThrow = false } = {}) {
  const deadline = Date.now() + 90_000;
  for (;;) {
    let ctx = null;
    let err = null;
    try {
      ctx = await run(name, args, o);
    } catch (e) {
      err = e;
    }
    if (err !== null) {
      if (settleThrow) return { err };
      throw err;
    }
    if (ctx.payload.index.state !== "building") return { ctx };
    if (Date.now() > deadline) throw new Error("index building не завершился за 90 с");
    await sleep(100);
  }
}

/** Файлы кэш-записей workspace: <CACHE>/<sha1(normalized ws)>/<key>.json. */
function recordFiles(ws) {
  const norm = ws.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
  const dir = join(CACHE, createHash("sha1").update(norm, "utf8").digest("hex"));
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => /^[0-9a-f]{64}\.json$/.test(f))
    .map((f) => join(dir, f));
}

function readRecord(ws) {
  const files = recordFiles(ws);
  assert.equal(files.length, 1, `ожидался один файл кэш-записи, найдено ${files.length}`);
  return JSON.parse(readFileSync(files[0], "utf8"));
}

let coldWs = null;

test.after(() => {
  if (coldWs !== null) rmSync(coldWs, { recursive: true, force: true });
  if (PREV_CACHE === undefined) delete process.env.ARCH_MCP_CACHE_DIR;
  else process.env.ARCH_MCP_CACHE_DIR = PREV_CACHE;
  rmSync(CACHE, { recursive: true, force: true });
});

test("1) холодный arch_status: ответ ≤3 с, index.state=building, пустые секции, graph=null", async () => {
  const ws = makeWs();
  coldWs = ws;
  const env = { ...process.env };
  const t0 = Date.now();
  const ctx = await lib.runTool("arch_status", { workspace: ws }, { env, cwd: ws });
  const elapsed = Date.now() - t0;
  const p = ctx.payload;

  assert.ok(elapsed <= 3000, `холодный arch_status ответил за ${elapsed} мс > 3000 мс`);
  assert.equal(p.ok, true, `ok=false: ${JSON.stringify(p.error ?? {})}`);
  assert.equal(p.index.state, "building", `state=${p.index.state}`);
  assert.ok(p.index.progress.percent >= 0 && p.index.progress.percent <= 100, `percent=${p.index.progress.percent}`);
  assert.deepEqual(p.index.adapters, [], "adapters в building должны быть пусты");
  assert.deepEqual(p.index.kinds, [], "kinds в building должны быть пусты");
  assert.deepEqual(p.index.missing, [], "missing в building должен быть пуст");
  assert.deepEqual(p.index.coverage, { files_seen: 0, parsed: 0, unsupported: [] }, "нулевая coverage");
  assert.equal(p.data.graph, null, `data.graph=${JSON.stringify(p.data.graph)}`);
  assert.equal(p.data.toolchain.status, "building", `toolchain.status=${p.data.toolchain.status}`);
  assert.equal(p.truncated, false, "truncated=true");
  assert.equal(ctx.cached, false, "ctx.cached=true");
  assert.equal(p._meta.provenance.cached, false, "provenance.cached=true");
  assert.ok(typeof p.data.hint === "string" && p.data.hint.length > 0, "hint отсутствует в building-ответе");
});

test("2) после фонового завершения: ready/partial, cached=true, фоновых прогонов ровно один", async () => {
  const ws = coldWs;
  assert.ok(ws, "холодный workspace из кейса 1 не создан");
  const env = { ...process.env };
  const { ctx } = await waitBuilt(lib.runTool, "arch_status", { workspace: ws }, { env, cwd: ws });
  const p = ctx.payload;

  assert.ok(["ready", "partial"].includes(p.index.state), `state=${p.index.state}`);
  assert.equal(ctx.cached, true, "повторный arch_status после сборки должен быть из кэша");
  assert.equal(p._meta.provenance.cached, true, "provenance.cached=false");
  assert.equal(counterRuns, 1, `фоновых прогонов ${counterRuns}, ожидался ровно 1`);
});

test("3) focus на холодном workspace: строгий ждёт прогон, параллельные focus — single-flight", async () => {
  const ws = makeWs();
  const env = { ...process.env };
  const o = { env, cwd: ws };
  try {
    const before = counterRuns;
    const st = await lib.runTool("arch_status", { workspace: ws }, o);
    assert.equal(st.payload.index.state, "building", `cold arch_status: state=${st.payload.index.state}`);

    const [f1, f2] = await Promise.all([
      lib.runTool("focus", { workspace: ws, node: "src/a.ts" }, o),
      lib.runTool("focus", { workspace: ws, node: "src/b.ts" }, o),
    ]);
    assert.equal(f1.payload.ok, true, `focus #1: ${JSON.stringify(f1.payload.error ?? {})}`);
    assert.equal(f2.payload.ok, true, `focus #2: ${JSON.stringify(f2.payload.error ?? {})}`);
    assert.equal(f1.payload.data.node, "src/a.ts");
    assert.equal(f2.payload.data.node, "src/b.ts");
    assert.equal(counterRuns - before, 1, `прогонов ${counterRuns - before}, ожидались 1 (оба focus ждут один прогон)`);

    await waitBuilt(lib.runTool, "arch_status", { workspace: ws }, o); // не оставляем фоновый прогон
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test("4) деградация core: degraded-запись, TTL-хит без пересбора, после TTL — пересбор", async () => {
  const ttl = lib.DEGRADED_TTL_MS;
  assert.equal(typeof ttl, "number", "DEGRADED_TTL_MS не экспортирован из dist/lib.mjs");

  // Фейковый корень: depcruiser «висит» бесконечно → таймаут core (детерминированно).
  const root = mkdtempSync(join(tmpdir(), "arch-mcp-robust-root-"));
  let lib2 = null;
  try {
    mkdirSync(join(root, "dist"), { recursive: true });
    copyFileSync(new URL("../dist/lib.mjs", import.meta.url), join(root, "dist", "lib.mjs"));
    symlinkSync(ARCH_MCP + "\\node_modules", join(root, "node_modules"), "junction");
    mkdirSync(join(root, "toolchain", "node_modules", "dependency-cruiser", "bin"), { recursive: true });
    writeFileSync(
      join(root, "toolchain", "toolchain.lock.json"),
      JSON.stringify({ package: "dependency-cruiser", version: "0.0.0-hang" }),
      "utf8",
    );
    writeFileSync(
      join(root, "toolchain", "node_modules", "dependency-cruiser", "bin", "dependency-cruiser.mjs"),
      "setInterval(() => {}, 1000);\n",
      "utf8",
    );
    lib2 = await import(pathToFileURL(join(root, "dist", "lib.mjs")).href);

    let hangRuns = 0;
    lib2.registerAdapter({
      id: "zz-robust-hang",
      version: "1.0.0",
      license: "MIT",
      precision: "syntax",
      priority: 1,
      detect: async () => [],
      scan: async function* () {},
      outcome: async () => {
        hangRuns += 1;
        return { status: "ok", deltas: [] };
      },
    });

    const ws = makeWs();
    const env = { ...process.env, ARCH_MCP_TIMEOUT_MS: "2000" };
    const o = { env, cwd: ws };
    try {
      const st = await lib2.runTool("arch_status", { workspace: ws }, o);
      assert.equal(st.payload.index.state, "building", `cold arch_status: state=${st.payload.index.state}`);

      // Фоновый прогон завершается деградацией → строгий путь конверта отвечает ошибкой.
      const settled = await waitBuilt(lib2.runTool, "arch_status", { workspace: ws }, o, { settleThrow: true });
      assert.ok(settled.err, "после деградации ожидалась ошибка, а не building");
      assert.equal(settled.err.code, "EXTERNAL_TOOL_FAILED", `код=${settled.err.code}`);
      assert.equal(hangRuns, 1, `прогонов ${hangRuns}, ожидался 1`);

      // Запись с degraded {reason, ts} (ТЗ B).
      const rec = readRecord(ws);
      assert.ok(rec.value.degraded, "в кэш-записи нет degraded");
      assert.equal(typeof rec.value.degraded.reason, "string");
      assert.ok(rec.value.degraded.reason.length > 0, "degraded.reason пуст");
      assert.ok(!Number.isNaN(Date.parse(rec.value.degraded.ts)), `degraded.ts=${rec.value.degraded.ts}`);
      assert.equal(rec.value.adapterStatuses.find((s) => s.name === "depcruiser").status, "timeout");

      // Повтор в пределах TTL — без пересбора (spy не растёт).
      const t0 = Date.now();
      let repeatErr = null;
      try {
        await lib2.runTool("arch_status", { workspace: ws }, o);
      } catch (e) {
        repeatErr = e;
      }
      const elapsed = Date.now() - t0;
      assert.ok(repeatErr, "повтор в пределах TTL должен отдать статус деградации, а не пересобрать");
      assert.equal(repeatErr.code, "EXTERNAL_TOOL_FAILED", `код повтора=${repeatErr.code}`);
      assert.equal(hangRuns, 1, `повтор пересобрал прогон: hangRuns=${hangRuns}`);
      assert.ok(elapsed < 3000, `повтор занял ${elapsed} мс — ожидался кэш-хит без прогона`);

      // После TTL — пересбор: правка degraded.ts в файле кэш-записи (без sleep).
      const file = recordFiles(ws)[0];
      const raw = JSON.parse(readFileSync(file, "utf8"));
      const expired = new Date(Date.now() - ttl - 60_000).toISOString();
      raw.value = { ...raw.value, degraded: { ...raw.value.degraded, ts: expired } };
      writeFileSync(file, JSON.stringify(raw), "utf8");

      const rebuilt = await waitBuilt(lib2.runTool, "arch_status", { workspace: ws }, o, { settleThrow: true });
      assert.ok(rebuilt.err, "после истечения TTL ожидалась ошибка деградации нового прогона");
      assert.equal(hangRuns, 2, `после TTL прогонов ${hangRuns}, ожидался пересбор (2)`);
      const rec2 = readRecord(ws);
      assert.ok(Date.parse(rec2.value.degraded.ts) > Date.parse(expired), "degraded.ts не обновился пересбором");
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("5) optional not_available при core ok: status/evidence — core, missing есть, focus отвечает, запись не degraded", async () => {
  lib.registerAdapter({
    id: "zz-robust-opt",
    version: "1.0.0",
    license: "MIT",
    precision: "syntax",
    priority: 199, // выше git(150)/depcruiser(100): при старом коде он становился primary
    detect: async () => [{ id: "zz-robust-opt", confidence: "syntax" }],
    scan: async function* () {},
    outcome: async () => ({
      status: "not_available",
      evidence: { command: "optional-tool --probe", exit_code: null, stdout: "", stderr: "optional tool missing", stdout_bytes: 0 },
      deltas: [],
    }),
  });

  const ws = makeWs();
  const env = { ...process.env };
  const o = { env, cwd: ws };
  try {
    const { ctx } = await waitBuilt(lib.runTool, "arch_status", { workspace: ws }, o);
    const p = ctx.payload;
    assert.equal(p.index.state, "partial", `state=${p.index.state}`);
    assert.ok(p.index.missing.includes("zz-robust-opt"), `нет в missing: ${JSON.stringify(p.index.missing)}`);
    assert.equal(p.index.adapters.find((a) => a.name === "zz-robust-opt").status, "not_available");

    const full = await lib.loadFullGraph(ws, lib.loadConfig(env));
    assert.equal(full.status, "ok", `FullGraph.status=${full.status} — должен быть core-статус, а не optional`);
    assert.match(String(full.evidence.command), /dependency-cruiser/, `evidence не core: ${full.evidence.command}`);
    assert.equal(full.adapters.find((a) => a.name === "zz-robust-opt").status, "not_available");

    const focusRes = await lib.runTool("focus", { workspace: ws, node: "src/a.ts" }, o);
    assert.equal(focusRes.payload.ok, true, `focus: ${JSON.stringify(focusRes.payload.error ?? {})}`);

    const rec = readRecord(ws);
    assert.ok(rec.value.degraded === undefined, `запись не должна быть degraded: ${JSON.stringify(rec.value.degraded)}`);
    assert.equal(rec.value.adapterStatuses.find((s) => s.name === "zz-robust-opt").status, "not_available");
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test("6) кэш-hit на git-workspace: inspectGit ровно 1 за runTool, спавны только git (≤3)", async () => {
  const ws = mkdtempSync(join(tmpdir(), "arch-mcp-robust-git-"));
  const env = { ...process.env };
  const o = { env, cwd: ws };
  try {
    mkdirSync(join(ws, "src"), { recursive: true });
    writeFileSync(join(ws, "package.json"), JSON.stringify({ name: "robust-git", version: "1.0.0", type: "module" }), "utf8");
    writeFileSync(join(ws, "src", "a.ts"), "export const a = 1;\n", "utf8");
    writeFileSync(join(ws, "src", "b.ts"), 'import { a } from "./a.ts";\nexport const b = a;\n', "utf8");
    const git = (args) => {
      const r = spawnSync("git", args, { cwd: ws, encoding: "utf8" });
      assert.equal(r.status, 0, `git ${args.join(" ")} → ${r.status}: ${r.stderr}`);
      return r;
    };
    git(["init"]);
    git(["add", "."]);
    git(["-c", "user.name=robust", "-c", "user.email=robust@example.invalid", "-c", "commit.gpgsign=false", "commit", "-m", "init"]);

    // Прогрев: первый вызов стартует фоновый прогон, поллинг доводит до готовности.
    await waitBuilt(lib.runTool, "arch_status", { workspace: ws }, o);

    assert.equal(typeof lib.spawnStats, "object", "spawnStats не экспортирован из dist/lib.mjs");
    assert.equal(typeof lib.inspectGitStats, "object", "inspectGitStats не экспортирован из dist/lib.mjs");
    assert.equal(typeof lib.resetSpawnStats, "function", "resetSpawnStats не экспортирован");
    assert.equal(typeof lib.resetInspectGitStats, "function", "resetInspectGitStats не экспортирован");

    lib.resetSpawnStats();
    lib.resetInspectGitStats();
    const t0 = Date.now();
    const ctx = await lib.runTool("arch_status", { workspace: ws }, o);
    const one = Date.now() - t0;
    assert.equal(ctx.cached, true, `кэш-hit не достигнут (cached=${ctx.cached})`);
    assert.equal(lib.inspectGitStats.count, 1, `inspectGit вызван ${lib.inspectGitStats.count} раз(а), ожидался 1`);
    assert.ok(lib.spawnStats.count <= 3, `спавнов ${lib.spawnStats.count} > 3: ${JSON.stringify(lib.spawnStats.byCommand)}`);
    const cmds = Object.keys(lib.spawnStats.byCommand);
    assert.ok(cmds.length > 0, "спавнов не зафиксировано");
    assert.ok(cmds.every((c) => c.startsWith("git ")), `не-git спавны при кэш-хите: ${JSON.stringify(cmds)}`);
    for (const sub of ["git rev-parse", "git status", "git log"]) {
      assert.ok(lib.spawnStats.byCommand[sub] >= 1, `нет спавна ${sub}: ${JSON.stringify(lib.spawnStats.byCommand)}`);
    }

    // Замер кэш-hit (ТЗ: медиана 5 прогонов ≤2 с — фиксируется в отчёте, не assert).
    const times = [one];
    for (let i = 1; i < 5; i++) {
      const t = Date.now();
      const c = await lib.runTool("arch_status", { workspace: ws }, o);
      times.push(Date.now() - t);
      assert.equal(c.cached, true, `прогон ${i + 1} не из кэша`);
    }
    const sorted = [...times].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];
    console.log(`[robustness] кэш-hit git-workspace: ${times.join(", ")} мс; медиана ${median} мс`);
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test("7) версии: SCHEMA_VERSION=6, GRAPH_SCHEMA_VERSION=graph-9; kinds-инвариант вне building", () => {
  assert.equal(lib.SCHEMA_VERSION, 6, `SCHEMA_VERSION=${lib.SCHEMA_VERSION}`);
  assert.equal(lib.GRAPH_SCHEMA_VERSION, "graph-9", `GRAPH_SCHEMA_VERSION=${lib.GRAPH_SCHEMA_VERSION}`);

  const idx = lib.buildIndexBlock({
    gitAvailable: true,
    depcruiseStatus: "ok",
    depcruiseVersion: "18.7.0",
    filesSeen: 10,
    parsed: 10,
    unsupported: [],
    graphEmpty: false,
  });
  assert.equal(idx.kinds.length, 10, `вне building kinds=${idx.kinds.length}`);
  assert.notEqual(idx.state, "building");

  assert.equal(typeof lib.buildBuildingIndex, "function", "buildBuildingIndex не экспортирован из dist/lib.mjs");
  const building = lib.buildBuildingIndex(0);
  assert.equal(building.state, "building");
  assert.deepEqual(building.kinds, [], "в building kinds должен быть пуст");
  assert.deepEqual(building.adapters, [], "в building adapters должны быть пусты");
  assert.deepEqual(building.missing, [], "в building missing должен быть пуст");
  assert.deepEqual(building.coverage, { files_seen: 0, parsed: 0, unsupported: [] });
  assert.equal(building.progress.complete, false);
});
