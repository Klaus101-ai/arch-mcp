// T2a: пайплайн WASM tree-sitter — два языка (TS/JS и Python), ТЗ рев.3 §7/§6.
// Тест-план T2a (TDD): (1) TS → symbol/calls, ни одного module/imports от tree-sitter (R6);
// (2) Python import/from-import → imports-ребро на существующий файл;
// (3) неразрешимый импорт → ребра нет, исключения нет, файл учтён в coverage;
// (4) битый wasm → not_available в index.adapters/missing[], ядро отвечает, state=partial;
// (5) детерминизм: повторный прогон даёт те же узлы/рёбра в том же порядке.
// Плюс регистрация в builtinAdapters() (priority 50, syntax, MIT).
import assert from "node:assert/strict";
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import * as lib from "../dist/lib.mjs";

const ROOT = resolve("E:\\1_Products\\arch-mcp");
const GRAMMARS = join(ROOT, "grammars");

const tsjs = lib.treeSitterTsjsAdapter;
const py = lib.treeSitterPythonAdapter;

function scanCtx(root) {
  return {
    root,
    roots: [root],
    gitHead: null,
    files: [],
    capabilities: [{ id: "scan", confidence: "syntax" }],
    cacheDir: "",
    timeoutMs: 60_000,
    maxBytes: 1_048_576,
  };
}

async function scan(adapter, root) {
  return lib.runAdapter(adapter, scanCtx(root));
}

const TS_SRC = [
  "export function alpha(n) {",
  "  return beta(n) + 1;",
  "}",
  "export function beta(n) {",
  "  return n * 2;",
  "}",
  "export class Widget {",
  "  run() {",
  "    return alpha(2);",
  "  }",
  "}",
  "",
].join("\n");

test("T2a-регистрация: оба адаптера в builtinAdapters(), priority 50, precision syntax, license MIT", () => {
  assert.ok(tsjs, "нет treeSitterTsjsAdapter в dist/lib.mjs");
  assert.ok(py, "нет treeSitterPythonAdapter в dist/lib.mjs");
  const ids = lib.builtinAdapters().map((a) => a.id);
  assert.deepEqual(
    ids,
    ["scip", "git", "depcruiser", "api", "ci", "dockerfile", "docs", "k8s", "manifests", "sql", "terraform", "tree-sitter-c", "tree-sitter-cpp", "tree-sitter-csharp", "tree-sitter-go", "tree-sitter-java", "tree-sitter-kotlin", "tree-sitter-php", "tree-sitter-python", "tree-sitter-ruby", "tree-sitter-rust", "tree-sitter-tsjs"],
    `состав/порядок builtinAdapters: ${ids}`,
  );
  for (const a of [tsjs, py]) {
    assert.equal(a.priority, 50, `${a.id}: priority 50`);
    assert.equal(a.precision, "syntax", `${a.id}: precision`);
    assert.equal(a.license, "MIT", `${a.id}: license`);
    assert.ok(typeof a.version === "string" && a.version.length > 0, `${a.id}: version из package.json`);
    assert.equal(typeof a.detect, "function", `${a.id}: detect`);
    assert.equal(typeof a.scan, "function", `${a.id}: scan`);
    assert.equal(typeof a.outcome, "function", `${a.id}: outcome`);
  }
});

test("T2a-1: TS-файл → symbol-узлы и calls-рёбра, ни одного module/imports от tree-sitter (R6)", async () => {
  assert.ok(tsjs, "нет treeSitterTsjsAdapter в dist/lib.mjs");
  const dir = mkdtempSync(join(tmpdir(), "arch-mcp-tsjs-"));
  try {
    mkdirSync(join(dir, "src"), { recursive: true });
    writeFileSync(join(dir, "src", "core.ts"), TS_SRC, "utf8");

    const run = await scan(tsjs, dir);
    assert.equal(run.status, "ok", `status=${run.status}`);
    const delta = run.deltas[0];
    assert.ok(delta, "дельта не вернулась");

    const symbols = delta.nodes.filter((n) => n.kind === "symbol");
    assert.ok(symbols.length >= 3, `symbol-узлов мало: ${JSON.stringify(delta.nodes.map((n) => n.id))}`);
    assert.ok(
      symbols.every((n) => /^symbol:src\/core\.ts#[^#]+$/.test(n.id)),
      `id symbol-узлов: ${JSON.stringify(symbols.map((n) => n.id))}`,
    );

    const kinds = [...new Set(delta.edges.map((e) => e.kind))];
    assert.ok(delta.edges.length >= 2, `calls-рёбер мало: ${JSON.stringify(delta.edges)}`);
    assert.deepEqual(kinds, ["calls"], `допустим только kind=calls, есть: ${kinds}`);
    const nodeKinds = [...new Set(delta.nodes.map((n) => n.kind))];
    assert.deepEqual(nodeKinds, ["symbol"], `допустим только kind=symbol, есть: ${nodeKinds}`);

    const calls = delta.edges.filter((e) => e.kind === "calls");
    assert.ok(
      calls.some((e) => e.source.endsWith("#alpha") && e.target.endsWith("#beta")),
      `нет вызова alpha→beta: ${JSON.stringify(calls)}`,
    );
    assert.ok(
      calls.every((e) => e.source.startsWith("symbol:") && e.target.startsWith("symbol:")),
      `calls-рёбра только между symbol-узлами: ${JSON.stringify(calls)}`,
    );

    assert.ok(delta.coverage.files_seen >= 1, `files_seen=${delta.coverage.files_seen}`);
    assert.ok(delta.coverage.parsed >= 1, `parsed=${delta.coverage.parsed}`);
    assert.deepEqual(delta.coverage.unsupported, [], "unsupported должен быть пуст");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("T2a-2: Python import x и from x import y → imports-ребро на существующий файл", async () => {
  assert.ok(py, "нет treeSitterPythonAdapter в dist/lib.mjs");
  const dir = mkdtempSync(join(tmpdir(), "arch-mcp-pyimp-"));
  try {
    writeFileSync(join(dir, "main.py"), "import helper\nfrom helper import thing\n", "utf8");
    writeFileSync(join(dir, "helper.py"), "def thing():\n    return 1\n", "utf8");
    mkdirSync(join(dir, "pkg"), { recursive: true });
    writeFileSync(join(dir, "pkg", "__init__.py"), "", "utf8");
    writeFileSync(join(dir, "pkg", "child.py"), "from . import util\n", "utf8");
    writeFileSync(join(dir, "pkg", "util.py"), "def serve():\n    return 2\n", "utf8");

    const run = await scan(py, dir);
    assert.equal(run.status, "ok", `status=${run.status}`);
    const delta = run.deltas[0];
    assert.ok(delta, "дельта не вернулась");

    const mods = delta.nodes.filter((n) => n.kind === "module");
    assert.ok(
      mods.some((n) => n.id === "main.py"),
      `нет module-узла main.py: ${JSON.stringify(delta.nodes.map((n) => n.id))}`,
    );
    assert.ok(
      mods.some((n) => n.id === "pkg/child.py"),
      `нет module-узла pkg/child.py: ${JSON.stringify(delta.nodes.map((n) => n.id))}`,
    );

    const imps = delta.edges.filter((e) => e.kind === "imports");
    assert.ok(
      imps.some((e) => e.source === "main.py" && e.target === "helper.py"),
      `нет ребра main.py→helper.py: ${JSON.stringify(imps)}`,
    );
    assert.ok(
      imps.some((e) => e.source === "pkg/child.py" && e.target === "pkg/util.py"),
      `нет ребра pkg/child.py→pkg/util.py: ${JSON.stringify(imps)}`,
    );
    for (const e of imps) assert.equal(e.confidence, "syntax", `confidence: ${JSON.stringify(e)}`);

    const ids = new Set(delta.nodes.map((n) => n.id));
    for (const e of imps) assert.ok(ids.has(e.target), `цель ребра не в узлах: ${e.target}`);

    assert.ok(delta.coverage.files_seen >= 5, `files_seen=${delta.coverage.files_seen}`);
    assert.deepEqual(delta.coverage.unsupported, [], "unsupported должен быть пуст");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("T2a-3: неразрешимый импорт → ребра нет, исключения нет, файл учтён в coverage", async () => {
  assert.ok(py, "нет treeSitterPythonAdapter в dist/lib.mjs");
  const dir = mkdtempSync(join(tmpdir(), "arch-mcp-pyghost-"));
  try {
    writeFileSync(
      join(dir, "ghost.py"),
      "import totally_missing_module_xyz\nfrom another_missing_module import nothing\n\ndef go():\n    return 1\n",
      "utf8",
    );

    const run = await scan(py, dir); // исключений быть не должно
    assert.equal(run.status, "ok", `status=${run.status} evidence=${JSON.stringify(run.evidence)}`);
    const delta = run.deltas[0];
    assert.ok(delta, "дельта не вернулась");

    const fromGhost = delta.edges.filter((e) => e.source === "ghost.py");
    assert.deepEqual(fromGhost, [], `неожиданные рёбра от ghost.py: ${JSON.stringify(fromGhost)}`);
    assert.ok(
      delta.nodes.some((n) => n.id === "ghost.py"),
      `файл ghost.py не учтён: ${JSON.stringify(delta.nodes.map((n) => n.id))}`,
    );
    assert.ok(delta.coverage.files_seen >= 1, `files_seen=${delta.coverage.files_seen}`);
    assert.ok(delta.coverage.parsed >= 1, `parsed=${delta.coverage.parsed}`);
    assert.deepEqual(delta.coverage.unsupported, [], "unsupported должен быть пуст");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("T2a-4: битый wasm грамматики → not_available в index.adapters/missing[], ядро отвечает, state=partial", async () => {
  assert.ok(existsSync(GRAMMARS), `нет grammars/ — копировать нечего: ${GRAMMARS}`);
  assert.ok(tsjs, "нет treeSitterTsjsAdapter в dist/lib.mjs");
  assert.ok(py, "нет treeSitterPythonAdapter в dist/lib.mjs");

  const gtmp = mkdtempSync(join(tmpdir(), "arch-mcp-grammars-"));
  const repo = mkdtempSync(join(tmpdir(), "arch-mcp-badwasm-"));
  const cache = mkdtempSync(join(tmpdir(), "arch-mcp-badwasm-cache-"));
  const savedGrammarDir = process.env.ARCH_MCP_GRAMMAR_DIR;
  try {
    cpSync(GRAMMARS, gtmp, { recursive: true });
    writeFileSync(join(gtmp, "tree-sitter-python.wasm"), "this is definitely not a wasm module", "utf8");

    mkdirSync(join(repo, "pkg"), { recursive: true });
    // Манифест: resolveWorkspace требует git-корень либо манифест.
    writeFileSync(join(repo, "pyproject.toml"), "[project]\nname = 'badwasm-fixture'\n", "utf8");
    writeFileSync(join(repo, "pkg", "a.py"), "def f():\n    return 1\n", "utf8");

    process.env.ARCH_MCP_GRAMMAR_DIR = gtmp;
    // Прогрев (ТЗ v3, п.A): холодный arch_status отдаёт building и не ждёт
    // сборку — поллинг до готовности, затем проверяем индекс.
    const o = { env: { ...process.env, ARCH_MCP_CACHE_DIR: cache }, cwd: repo };
    let res;
    for (let i = 0; i < 900; i++) {
      res = await lib.runTool("arch_status", { workspace: repo }, o);
      if (res.payload.index.state !== "building") break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    const env = res.payload;
    assert.equal(env.ok, true, "ядро обязано ответить при битом wasm");

    const entry = env.index.adapters.find((a) => a.name === "tree-sitter-python");
    assert.ok(
      entry,
      `tree-sitter-python не в index.adapters: ${JSON.stringify(env.index.adapters)}`,
    );
    assert.equal(entry.status, "not_available", `status=${entry.status}`);
    assert.ok(
      env.index.missing.includes("tree-sitter-python"),
      `нет в missing[]: ${JSON.stringify(env.index.missing)}`,
    );
    assert.equal(env.index.state, "partial", `state=${env.index.state}`);

    // Адаптер с нулём подходящих файлов (нет .ts) не попадает ни в adapters, ни в missing.
    assert.ok(
      !env.index.adapters.some((a) => a.name === "tree-sitter-tsjs"),
      `tsjs без .ts-файлов не должен быть в index: ${JSON.stringify(env.index.adapters)}`,
    );
    assert.ok(!env.index.missing.includes("tree-sitter-tsjs"), "tsjs не должен быть в missing[]");
  } finally {
    if (savedGrammarDir === undefined) delete process.env.ARCH_MCP_GRAMMAR_DIR;
    else process.env.ARCH_MCP_GRAMMAR_DIR = savedGrammarDir;
    rmSync(gtmp, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
    rmSync(cache, { recursive: true, force: true });
  }
});

test("T2a-5: детерминизм — повторный прогон даёт те же узлы/рёбра в том же порядке", async () => {
  assert.ok(py, "нет treeSitterPythonAdapter в dist/lib.mjs");
  assert.ok(tsjs, "нет treeSitterTsjsAdapter в dist/lib.mjs");

  const pyDir = mkdtempSync(join(tmpdir(), "arch-mcp-det-py-"));
  const tsDir = mkdtempSync(join(tmpdir(), "arch-mcp-det-ts-"));
  try {
    writeFileSync(join(pyDir, "main.py"), "import helper\n\ndef run():\n    return helper.thing()\n", "utf8");
    writeFileSync(join(pyDir, "helper.py"), "def thing():\n    return 1\n", "utf8");
    writeFileSync(join(pyDir, "other.py"), "from helper import thing\n", "utf8");

    const a1 = await scan(py, pyDir);
    const a2 = await scan(py, pyDir);
    assert.equal(a1.status, "ok", `status=${a1.status}`);
    assert.equal(a2.status, "ok", `status=${a2.status}`);
    assert.deepEqual(a2.deltas[0].nodes, a1.deltas[0].nodes, "python: узлы/порядок не повторились");
    assert.deepEqual(a2.deltas[0].edges, a1.deltas[0].edges, "python: рёбра/порядок не повторились");
    assert.deepEqual(a2.deltas[0].coverage, a1.deltas[0].coverage, "python: coverage не повторился");

    mkdirSync(join(tsDir, "src"), { recursive: true });
    writeFileSync(join(tsDir, "src", "core.ts"), TS_SRC, "utf8");
    writeFileSync(join(tsDir, "src", "extra.ts"), "export const extra = alpha(1);\n", "utf8");

    const b1 = await scan(tsjs, tsDir);
    const b2 = await scan(tsjs, tsDir);
    assert.equal(b1.status, "ok", `status=${b1.status}`);
    assert.equal(b2.status, "ok", `status=${b2.status}`);
    assert.deepEqual(b2.deltas[0].nodes, b1.deltas[0].nodes, "tsjs: узлы/порядок не повторились");
    assert.deepEqual(b2.deltas[0].edges, b1.deltas[0].edges, "tsjs: рёбра/порядок не повторились");
    assert.deepEqual(b2.deltas[0].coverage, b1.deltas[0].coverage, "tsjs: coverage не повторился");
  } finally {
    rmSync(pyDir, { recursive: true, force: true });
    rmSync(tsDir, { recursive: true, force: true });
  }
});
