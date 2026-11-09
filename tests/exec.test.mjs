import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ArchMcpError,
  assertExecAllowed,
  externalTimeoutError,
  inspectGit,
  isExecAllowed,
  runExternal,
} from "../dist/lib.mjs";

test("runExternal: успешный запуск → exitCode 0, stdout", async () => {
  const res = await runExternal(process.execPath, ["-e", "process.stdout.write('hello')"], { timeoutMs: 15_000 });
  assert.equal(res.exitCode, 0);
  assert.equal(res.stdout, "hello");
  assert.equal(res.timedOut, false);
  assert.equal(res.spawnError, false);
});

test("runExternal: несуществующий бинарь → spawnError, без падения", async () => {
  const res = await runExternal("arch-mcp-no-such-binary-xyz", ["--version"], { timeoutMs: 5_000 });
  assert.equal(res.spawnError, true);
  assert.equal(res.timedOut, false);
  assert.ok(res.stderr.length > 0, "stderr пуст");
});

test("runExternal: таймаут → timedOut, дерево убито, команда завершается", async () => {
  const started = Date.now();
  const res = await runExternal(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { timeoutMs: 700 });
  const elapsed = Date.now() - started;
  assert.equal(res.timedOut, true, "timedOut не установлен");
  assert.ok(elapsed < 10_000, `дерево не убито за 10с: ${elapsed} мс`);
});

test("externalTimeoutError: EXTERNAL_TOOL_FAILED с timeout_ms в сообщении", () => {
  const err = externalTimeoutError("depcruiser", 120_000);
  assert.ok(err instanceof ArchMcpError);
  assert.equal(err.code, "EXTERNAL_TOOL_FAILED");
  assert.match(err.message, /timeout_ms=120000/);
  assert.match(String(err.hint), /ARCH_MCP_TIMEOUT_MS/);
});

test("ARCH_MCP_ALLOW_EXEC: без флага опциональные внешние инструменты запрещены", () => {
  assert.equal(isExecAllowed({}), false);
  assert.equal(isExecAllowed({ ARCH_MCP_ALLOW_EXEC: "1" }), true);
  assert.equal(isExecAllowed({ ARCH_MCP_ALLOW_EXEC: "true" }), true);

  try {
    assertExecAllowed("scip", {});
    assert.fail("ожидался ADAPTER_UNAVAILABLE");
  } catch (err) {
    assert.ok(err instanceof ArchMcpError);
    assert.equal(err.code, "ADAPTER_UNAVAILABLE");
    assert.match(String(err.hint), /ARCH_MCP_ALLOW_EXEC/);
    assert.match(String(err.message), /scip/);
  }
  assert.doesNotThrow(() => assertExecAllowed("scip", { ARCH_MCP_ALLOW_EXEC: "1" }));
});

test("inspectGit: git доступен (spawnError=false) на существующем каталоге", async () => {
  const info = await inspectGit("E:\\1_Products\\arch-mcp", 15_000);
  assert.equal(info.available, true, "git-бинарь должен быть доступен");
  assert.equal(info.isRepo, false, "arch-mcp — не git-репозиторий");
  assert.equal(info.gitHead, null);
});
