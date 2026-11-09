import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
import { registerAdapter, runTool } from "../dist/lib.mjs";

// ТЗ рев.2:
//  п.1 — не блокировать event loop: WORKSPACE_NOT_FOUND ≤1 с при workspace
//        до 1000 файлов (≤3 с сверх), даже если идёт построение;
//  п.2 — single-flight: одновременные одинаковые вызовы → один прогон;
//  п.3 — fail-fast: resolveWorkspace/assertIndexBuilding до тяжёлой работы.

const CACHE = mkdtempSync(join(tmpdir(), "arch-mcp-concurrency-"));
const ENV = { ...process.env, ARCH_MCP_CACHE_DIR: CACHE };

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function makeWorkspace() {
  const ws = mkdtempSync(join(tmpdir(), "arch-mcp-concws-"));
  mkdirSync(join(ws, "src"), { recursive: true });
  writeFileSync(
    join(ws, "package.json"),
    JSON.stringify({ name: "concurrency-fixture", version: "1.0.0", type: "module" }),
    "utf8",
  );
  writeFileSync(join(ws, "src", "a.ts"), "export const a = 1;\n", "utf8");
  return ws;
}

/** Workspace из count файлов .go — даёт синхронную нагрузку tree-sitter (generic.ts). */
function makeBigWorkspace(count) {
  const ws = makeWorkspace();
  for (let i = 0; i < count; i++) {
    writeFileSync(join(ws, `m${i}.go`), `package m${i}\n\nfunc F${i}() int { return ${i} }\n`, "utf8");
  }
  return ws;
}

async function expectWorkspaceNotFound(fn) {
  try {
    await fn();
    assert.fail("ожидался WORKSPACE_NOT_FOUND");
  } catch (err) {
    assert.equal(err.code, "WORKSPACE_NOT_FOUND", `неожиданный код: ${err.code ?? err}`);
  }
}

/** Поллинг arch_status до выхода из building (ТЗ v3, п.A): прогон фоновый. */
async function waitBuilt(ws, o) {
  for (let i = 0; i < 900; i++) {
    const ctx = await runTool("arch_status", { workspace: ws }, o);
    if (ctx.payload.index.state !== "building") return ctx;
    await sleep(100);
  }
  throw new Error("index building не завершился за 90 с");
}

test.after(() => {
  rmSync(CACHE, { recursive: true, force: true });
});

test("п.2 single-flight: два одновременных focus ждут один фоновый прогон, адаптер отработал один раз", async () => {
  const ws = makeWorkspace();
  let runs = 0;
  registerAdapter({
    id: "zz-test-counter",
    version: "1.0.0",
    license: "MIT",
    precision: "syntax",
    priority: 1,
    detect: async () => [],
    scan: async function* () {},
    outcome: async () => {
      runs += 1;
      await sleep(1500); // окно одновременности для второго вызова
      return { status: "ok", deltas: [] };
    },
  });
  try {
    const opts = { env: ENV, cwd: ws };
    // Холодный arch_status стартует фоновый прогон и не ждёт (ТЗ v3, п.A).
    const st = await runTool("arch_status", { workspace: ws }, opts);
    assert.equal(st.payload.index.state, "building", `cold arch_status: state=${st.payload.index.state}`);

    const [first, second] = await Promise.all([
      runTool("focus", { workspace: ws, node: "src/a.ts" }, opts),
      runTool("focus", { workspace: ws, node: "src/a.ts" }, opts),
    ]);
    assert.equal(runs, 1, `single-flight нарушен: прогонов ${runs}`);
    // Оба строгих вызова ждут ТОТ ЖЕ прогон (не кэш): cached=false у обоих.
    assert.equal(first.cached, false, "первый вызов — не из кэша");
    assert.equal(second.cached, false, "второй ждёт тот же прогон, а не кэш");
    assert.deepEqual(second.payload.data, first.payload.data, "результаты должны совпадать");
    assert.deepEqual(second.payload.index, first.payload.index, "индексы должны совпадать");

    // Цикл building→ready: доводим фоновый прогон, не оставляем его висеть.
    await waitBuilt(ws, opts);
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test("п.1/п.3: WORKSPACE_NOT_FOUND <1 с, пока идёт построение с адаптером-задержкой", async () => {
  const ws = makeWorkspace();
  registerAdapter({
    id: "zz-test-delay",
    version: "1.0.0",
    license: "MIT",
    precision: "syntax",
    priority: 1,
    detect: async () => [],
    scan: async function* () {},
    outcome: async () => {
      await sleep(2000);
      return { status: "ok", deltas: [] };
    },
  });
  const missing = join(tmpdir(), "arch-mcp-no-such-workspace-xyz");
  try {
    const o = { env: ENV, cwd: ws };
    // Холодный arch_status стартует фоновый прогон и отвечает немедленно
    // (ТЗ v3, п.A) — проверка fail-fast идёт параллельно со стройкой.
    const st = await runTool("arch_status", { workspace: ws }, o);
    assert.equal(st.payload.index.state, "building", `cold arch_status: state=${st.payload.index.state}`);
    await sleep(50); // даём построению стартовать
    const started = Date.now();
    await expectWorkspaceNotFound(() => runTool("arch_status", { workspace: missing }, { env: ENV, cwd: tmpdir() }));
    const elapsed = Date.now() - started;
    assert.ok(elapsed <= 1000, `fail-fast не сработал: ${elapsed} мс > 1000 мс`);
    await waitBuilt(ws, o); // фоновый прогон доводим до конца — не оставляем висеть
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test("п.1: WORKSPACE_NOT_FOUND ≤1 с при workspace на 1000 файлов во время построения", async () => {
  const ws = makeBigWorkspace(1000);
  const missing = join(tmpdir(), "arch-mcp-no-such-workspace-2-xyz");
  try {
    const o = { env: ENV, cwd: ws };
    // Фоновое построение (ТЗ v3, п.A): arch_status не блокирует вызывающего.
    const st = await runTool("arch_status", { workspace: ws }, o);
    assert.equal(st.payload.index.state, "building", `cold arch_status: state=${st.payload.index.state}`);
    await sleep(100); // стройка уходит в синхронный парсинг файлов
    const started = Date.now();
    await expectWorkspaceNotFound(() => runTool("arch_status", { workspace: missing }, { env: ENV, cwd: tmpdir() }));
    const elapsed = Date.now() - started;
    assert.ok(elapsed <= 1000, `event loop блокируется построением: ${elapsed} мс > 1000 мс`);
    await waitBuilt(ws, o); // фоновый прогон доводим до конца
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test("п.: ADAPTER_UNAVAILABLE при отсутствующем toolchain (focus, строгий путь)", async () => {
  // Копия бандла в чистый temp-корень: packageRoot() указывает на temp →
  // toolchain/grammars там нет, реальный репозиторий не трогаем.
  const root = mkdtempSync(join(tmpdir(), "arch-mcp-notool-"));
  const ws = makeWorkspace();
  let junction = null;
  try {
    mkdirSync(join(root, "dist"), { recursive: true });
    copyFileSync(new URL("../dist/lib.mjs", import.meta.url), join(root, "dist", "lib.mjs"));
    // Внешние модули бандла (@asyncapi/parser и др.) — через junction на
    // node_modules репозитория: сам temp-корень toolchain/grammars не имеет.
    junction = join(root, "node_modules");
    symlinkSync("E:\\1_Products\\arch-mcp\\node_modules", junction, "junction");
    const lib = await import(pathToFileURL(join(root, "dist", "lib.mjs")).href);
    try {
      await lib.runTool(
        "focus",
        { workspace: ws, node: "src/a.ts" },
        { env: { ...ENV, ARCH_MCP_CACHE_DIR: mkdtempSync(join(tmpdir(), "arch-mcp-notool-cache-")) }, cwd: ws },
      );
      assert.fail("ожидался ADAPTER_UNAVAILABLE");
    } catch (err) {
      assert.equal(err.code, "ADAPTER_UNAVAILABLE", `неожиданный код: ${err.code ?? err}`);
      assert.match(String(err.hint), /npm run bootstrap/);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(ws, { recursive: true, force: true });
  }
});
