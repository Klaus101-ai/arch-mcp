import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { runDepcruiser } from "../dist/lib.mjs";

test("depcruiser отсутствует: status=not_available, хинт 'npm run bootstrap', без падения", async () => {
  const root = mkdtempSync(join(tmpdir(), "arch-mcp-notoolchain-"));
  try {
    const res = await runDepcruiser("E:/1_siteteam/asi-agent1", 5000, 65536, root);
    assert.equal(res.status, "not_available");
    assert.equal(res.hint, "npm run bootstrap");
    assert.equal(res.data, null);
    assert.ok(res.command.includes("dependency-cruiser.mjs"), "команда должна содержать JS-вход depcruise");
    assert.ok(res.command.startsWith("cwd="), "evidence должен начинаться с cwd");
    assert.ok(res.evidence.stderr.includes("not found"), "stderr должен называть отсутствующий бинарь");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
