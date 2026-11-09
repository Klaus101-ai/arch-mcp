import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { inspectGit } from "../dist/lib.mjs";

test("не-git репозиторий: git_head null, без падения", async () => {
  const dir = mkdtempSync(join(tmpdir(), "arch-mcp-nongit-"));
  try {
    const info = await inspectGit(dir, 10_000);
    assert.equal(info.isRepo, false);
    assert.equal(info.gitHead, null);
    assert.deepEqual(info.status, []);
    assert.equal(info.lastCommit, null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("несуществующий путь: git_head null, без падения", async () => {
  const info = await inspectGit(join(tmpdir(), "arch-mcp-does-not-exist-xyz"), 10_000);
  assert.equal(info.isRepo, false);
  assert.equal(info.gitHead, null);
});
