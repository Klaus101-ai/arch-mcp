import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { runTool } from "../dist/lib.mjs";

// ТЗ рев.2, п.4: кэш работает и для не-git workspace. Подпись = (path, mtimeMs, size)
// по всем файлам под workspace, исключая только node_modules и .git: правка любого
// файла вне этих каталогов (включая dist/) инвалидирует кэш.

const CACHE = mkdtempSync(join(tmpdir(), "arch-mcp-nongitcache-"));
const ENV = { ...process.env, ARCH_MCP_CACHE_DIR: CACHE };

function makeWorkspace() {
  const ws = mkdtempSync(join(tmpdir(), "arch-mcp-nongitws-"));
  mkdirSync(join(ws, "src"), { recursive: true });
  mkdirSync(join(ws, "dist"), { recursive: true });
  writeFileSync(
    join(ws, "package.json"),
    JSON.stringify({ name: "nongit-fixture", version: "1.0.0", type: "module" }),
    "utf8",
  );
  writeFileSync(join(ws, "src", "a.ts"), "export const a = 1;\n", "utf8");
  writeFileSync(join(ws, "dist", "artifact.js"), "export const x = 1;\n", "utf8");
  return ws;
}

test.after(() => {
  rmSync(CACHE, { recursive: true, force: true });
});

test("не-git кэш: первый arch_status — building, после готовности ready/cached, правка dist/ даёт новый ключ", async () => {
  const ws = makeWorkspace();
  const opts = { env: ENV, cwd: ws };
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const poll = async () => {
    for (let i = 0; i < 900; i++) {
      const ctx = await runTool("arch_status", { workspace: ws }, opts);
      if (ctx.payload.index.state !== "building") return ctx;
      await sleep(100);
    }
    throw new Error("index building не завершился за 90 с");
  };
  try {
    // Первый вызов (ТЗ v3, п.A): arch_status не ждёт сборку → building-конверт.
    const first = await runTool("arch_status", { workspace: ws }, opts);
    assert.equal(first.payload.index.state, "building", `state=${first.payload.index.state}`);
    assert.equal(first.cached, false, "building-ответ не из кэша");
    assert.equal(first.payload.data.graph, null, "в building data.graph=null");

    // После фонового завершения повторный вызов — ready/partial и из кэша.
    const ready = await poll();
    assert.ok(["ready", "partial"].includes(ready.payload.index.state), `state=${ready.payload.index.state}`);
    assert.equal(ready.cached, true, "после готовности повторный вызов должен быть из кэша");

    // Правка файла под dist/ (вне node_modules/.git) обязана инвалидировать кэш:
    // иначе третий вызов был бы кэш-хитом (ready/cached), а не building.
    writeFileSync(join(ws, "dist", "artifact.js"), "export const x = 2; // changed\n", "utf8");
    const third = await runTool("arch_status", { workspace: ws }, opts);
    assert.equal(third.payload.index.state, "building", `после правки state=${third.payload.index.state} — кэш не инвалидирован`);
    assert.equal(third.cached, false, "после правки файла кэш-хита быть не должно");
    const rebuilt = await poll();
    assert.ok(["ready", "partial"].includes(rebuilt.payload.index.state), `state=${rebuilt.payload.index.state}`);
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});
