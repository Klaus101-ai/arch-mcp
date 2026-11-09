import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, parse, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { normalizeDepcruiser, runDepcruiser } from "../dist/lib.mjs";

// Каталог исходников пакета (E:\1_Products\arch-mcp\src) — другой диск, чем %TEMP%.
const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..", "src");
const TIMEOUT = 120_000;
const BUDGET = 262_144;

/** cwd процесса должен отличаться от repo, иначе дефект не воспроизводится. */
function chdirToTemp() {
  const dir = mkdtempSync(join(tmpdir(), "arch-mcp-cwd-"));
  const previous = process.cwd();
  process.chdir(dir);
  return { dir, previous };
}

test("другой диск подтверждён: repo на E:, cwd теста на C:", () => {
  assert.notEqual(parse(repo).root, parse(tmpdir()).root, `repo ${repo} и tmp ${tmpdir()} должны быть на разных дисках`);
});

test("регрессия cwd: запуск из %TEMP%, repo на другом диске → nodes>0, exit_code 0", async () => {
  const { dir, previous } = chdirToTemp();
  try {
    assert.notEqual(process.cwd(), repo, "cwd обязан отличаться от repo");
    const res = await runDepcruiser(repo, TIMEOUT, BUDGET);
    assert.equal(res.status, "ok", `status=${res.status}, stderr=${res.evidence.stderr}`);
    assert.equal(res.evidence.exit_code, 0);
    const { nodes, edges } = normalizeDepcruiser(res.data);
    assert.ok(nodes.length > 0, "nodes пусты");
    assert.ok(edges.length > 0, "edges пусты");
    assert.ok(res.evidence.command.includes(`cwd=${repo}`), `в evidence нет cwd: ${res.evidence.command}`);
    assert.ok(res.evidence.command.includes("--exclude node_modules"), "потерян --exclude node_modules");
  } finally {
    process.chdir(previous);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("регрессия: repo с прямыми слэшами (E:/...) при cwd=%TEMP% → nodes>0, exit_code 0", async () => {
  const repoPosix = repo.replace(/\\/g, "/");
  const { dir, previous } = chdirToTemp();
  try {
    const res = await runDepcruiser(repoPosix, TIMEOUT, BUDGET);
    assert.equal(res.status, "ok", `status=${res.status}, stderr=${res.evidence.stderr}`);
    assert.equal(res.evidence.exit_code, 0);
    const { nodes, edges } = normalizeDepcruiser(res.data);
    assert.ok(nodes.length > 0, "nodes пусты");
    assert.ok(edges.length > 0, "edges пусты");
    assert.ok(res.evidence.command.includes(`cwd=${repoPosix}`), `в evidence нет cwd: ${res.evidence.command}`);
  } finally {
    process.chdir(previous);
    rmSync(dir, { recursive: true, force: true });
  }
});
