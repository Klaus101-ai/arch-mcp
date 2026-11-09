import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const CLI = resolve(dirname(fileURLToPath(import.meta.url)), "..", "dist", "cli.mjs");
const ROOT = resolve("E:\\1_Products\\arch-mcp");
const CACHE = mkdtempSync(join(tmpdir(), "arch-mcp-clicache-"));

function baseEnv() {
  const env = { ...process.env, ARCH_MCP_CACHE_DIR: CACHE };
  delete env.ARCH_MCP_MAX_RESPONSE_BYTES; // без env → дефолт 65536
  delete env.ARCH_MCP_ALLOWED_ROOTS;
  return env;
}

function run(args, env = baseEnv()) {
  return spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8", env, timeout: 120_000 });
}

/**
 * Прогрев (ТЗ v3, п.A): arch_status на холодном кэше отвечает building и не
 * ждёт сборку. Кэш прогревается строгим инструментом — search ждёт построение
 * и пишет запись; после этого status обязан отдать ready/partial.
 */
function warmStatus() {
  const w = run(["search", "--workspace", ROOT, "--query", "config", "--json"]);
  assert.equal(w.status, 0, `warmup exit=${w.status} stderr=${w.stderr}`);
  const r = run(["status", "--workspace", ROOT, "--json"]);
  assert.equal(r.status, 0, `exit=${r.status} stderr=${r.stderr}`);
  const env = JSON.parse(r.stdout);
  assert.notEqual(env.index.state, "building", "после прогрева status не должен отдавать building");
  return env;
}

test.after(() => {
  rmSync(CACHE, { recursive: true, force: true });
});

test("CLI status --json: конверт ok, index ready", () => {
  const env = warmStatus();
  assert.equal(env.ok, true);
  assert.equal(env.schema_version, 6);
  assert.equal(env.index.state, "ready", `state=${env.index.state}`);
  assert.equal(env.workspace, ROOT);
});

test("CLI status без env и --json: печатает budget: 65536", () => {
  warmStatus();
  const r = run(["status", "--workspace", ROOT]);
  assert.equal(r.status, 0, `exit=${r.status} stderr=${r.stderr}`);
  assert.match(r.stdout, /budget: 65536/, `нет budget в выводе:\n${r.stdout}`);
  assert.match(r.stdout, /workspace: /);
  assert.match(r.stdout, /index: ready/);
});

test("CLI search --query --json: находит config.ts", () => {
  const r = run(["search", "--workspace", ROOT, "--query", "config", "--json"]);
  assert.equal(r.status, 0, `exit=${r.status} stderr=${r.stderr}`);
  const env = JSON.parse(r.stdout);
  assert.equal(env.ok, true);
  assert.ok(env.data.count > 0, "count=0");
  assert.ok(env.data.matches.some((m) => m.node === "src/config.ts"), JSON.stringify(env.data.matches));
});

test("CLI affected-tests: маппинг команды и рабочий вызов", () => {
  const r = run(["affected-tests", "--workspace", ROOT, "--changed", "src/config.ts", "--json"]);
  assert.equal(r.status, 0, `exit=${r.status} stderr=${r.stderr}`);
  const env = JSON.parse(r.stdout);
  assert.equal(env.ok, true);
  assert.ok(Array.isArray(env.data.tests));
  assert.deepEqual(env.data.changed, ["src/config.ts"]);
});

test("CLI: неизвестная команда → exit 2", () => {
  const r = run(["bogus-command"]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /usage/i);
});

test("CLI: ошибка контракта → exit 1, NODE_NOT_FOUND (текст и --json)", () => {
  const r = run(["focus", "--workspace", ROOT, "--node", "src/no-such-file.ts"]);
  assert.equal(r.status, 1, `exit=${r.status}`);
  assert.match(r.stderr, /NODE_NOT_FOUND/);

  const j = run(["focus", "--workspace", ROOT, "--node", "src/no-such-file.ts", "--json"]);
  assert.equal(j.status, 1);
  const env = JSON.parse(j.stdout);
  assert.equal(env.ok, false);
  assert.equal(env.error.code, "NODE_NOT_FOUND");
});

test("CLI: max_bytes выше потолка → exit 1 BUDGET_EXCEEDED", () => {
  const r = run(["status", "--workspace", ROOT, "--max-bytes", "1048577"]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /BUDGET_EXCEEDED/);
});

test("CLI: diff без --from → exit 1 INVALID_ARGUMENT", () => {
  const r = run(["diff", "--workspace", ROOT, "--to", "current"]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /INVALID_ARGUMENT/);
});
