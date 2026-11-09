// T2b-2: универсальные языковые адаптеры (9 языков) + SCIP (ТЗ рев.3 §7).
// Тест-план T2b-2 (TDD): (1) каждый новый язык на своей фикстуре даёт
// module-узел и imports-ребро (confidence syntax); (2) неразрешимый импорт →
// без ребра, без исключения, файл в coverage; (3) битый wasm языка → только
// этот адаптер not_available/missing[], ядро отвечает, остальные работают;
// (4) детерминизм — повторный прогон даёт те же узлы/рёбра/coverage;
// (5) SCIP: .scip, собранный в тесте через toBinary → symbol-узлы и
// references-рёбра (precision semantic), нет файла → absent.
// Плюс регистрация: 9 языковых адаптеров + scip в builtinAdapters().
import assert from "node:assert/strict";
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { create, toBinary } from "@bufbuild/protobuf";
import { IndexSchema, DocumentSchema, OccurrenceSchema, SymbolRole } from "@scip-code/scip";
import * as lib from "../dist/lib.mjs";

const ROOT = resolve("E:\\1_Products\\arch-mcp");
const GRAMMARS = join(ROOT, "grammars");
const LANGS = fileURLToPath(new URL("./fixtures/langs", import.meta.url));

// adapterId → [входной файл фикстуры, ожидаемое ребро imports source→target].
const CASES = [
  ["tree-sitter-c", "main.c", [["main.c", "helper.h"]]],
  ["tree-sitter-cpp", "main.cpp", [["main.cpp", "helper.hpp"]]],
  ["tree-sitter-csharp", "Main.cs", [["Main.cs", "helper.cs"]]],
  ["tree-sitter-go", "main.go", [["main.go", "helper.go"]]],
  ["tree-sitter-java", "Main.java", [["Main.java", "pkg/Helper.java"]]],
  ["tree-sitter-kotlin", "main.kt", [["main.kt", "pkg/greet.kt"]]],
  ["tree-sitter-php", "index.php", [["index.php", "inc.php"], ["index.php", "Helper/Thing.php"]]],
  ["tree-sitter-ruby", "app.rb", [["app.rb", "helper.rb"]]],
  ["tree-sitter-rust", "main.rs", [["main.rs", "helper/run.rs"]]],
];

const SCIP_ID = "scip";

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

function adapterById(id) {
  const found = lib.builtinAdapters().find((a) => a.id === id);
  assert.ok(found, `нет адаптера ${id} в builtinAdapters()`);
  return found;
}

test("T2b-регистрация: 9 языковых адаптеров + scip в builtinAdapters(), порядок priority↓ затем id", () => {
  const ids = lib.builtinAdapters().map((a) => a.id);
  assert.deepEqual(
    ids,
    [
      "scip",
      "git",
      "depcruiser",
      "api",
      "ci",
      "dockerfile",
      "docs",
      "k8s",
      "manifests",
      "sql",
      "terraform",
      "tree-sitter-c",
      "tree-sitter-cpp",
      "tree-sitter-csharp",
      "tree-sitter-go",
      "tree-sitter-java",
      "tree-sitter-kotlin",
      "tree-sitter-php",
      "tree-sitter-python",
      "tree-sitter-ruby",
      "tree-sitter-rust",
      "tree-sitter-tsjs",
    ],
    `состав/порядок builtinAdapters: ${ids}`,
  );
  for (const [id] of CASES) {
    const a = adapterById(id);
    assert.equal(a.priority, 50, `${id}: priority 50`);
    assert.equal(a.precision, "syntax", `${id}: precision syntax`);
    assert.equal(a.license, "MIT", `${id}: license MIT`);
    assert.ok(typeof a.version === "string" && a.version.length > 0, `${id}: version`);
    assert.equal(typeof a.outcome, "function", `${id}: outcome`);
  }
  const scip = adapterById(SCIP_ID);
  assert.equal(scip.priority, 200, "scip: priority 200");
  assert.equal(scip.precision, "semantic", "scip: precision semantic");
  assert.equal(typeof scip.outcome, "function", "scip: outcome");
  assert.ok(typeof lib.treeSitterLanguageAdapters === "object", "нет treeSitterLanguageAdapters");
  assert.equal(lib.treeSitterLanguageAdapters.length, 9, `языковых адаптеров: ${lib.treeSitterLanguageAdapters?.length}`);
});

test("T2b-1: каждый новый язык на своей фикстуре даёт module-узел и imports", async () => {
  for (const [id, entry, expectedEdges] of CASES) {
    const adapter = adapterById(id);
    const dir = join(LANGS, id.replace("tree-sitter-", ""));
    assert.ok(existsSync(join(dir, entry)), `нет фикстуры ${dir}/${entry}`);
    const run = await scan(adapter, dir);
    assert.equal(run.status, "ok", `${id}: status=${run.status} evidence=${JSON.stringify(run.evidence)}`);
    const delta = run.deltas[0];
    assert.ok(delta, `${id}: дельта не вернулась`);

    assert.ok(
      delta.nodes.some((n) => n.kind === "module" && n.id === entry),
      `${id}: нет module-узла ${entry}: ${JSON.stringify(delta.nodes.map((n) => n.id))}`,
    );

    const imps = delta.edges.filter((e) => e.kind === "imports");
    for (const [src, tgt] of expectedEdges) {
      assert.ok(
        imps.some((e) => e.source === src && e.target === tgt),
        `${id}: нет ребра ${src}→${tgt}: ${JSON.stringify(imps)}`,
      );
    }
    for (const e of imps) assert.equal(e.confidence, "syntax", `${id}: confidence ${JSON.stringify(e)}`);

    const nodeIds = new Set(delta.nodes.map((n) => n.id));
    for (const e of imps) assert.ok(nodeIds.has(e.target), `${id}: цель ребра не в узлах: ${e.target}`);

    const syms = delta.nodes.filter((n) => n.kind === "symbol");
    assert.ok(syms.length >= 1, `${id}: нет symbol-узлов (best-effort): ${JSON.stringify(delta.nodes.map((n) => n.id))}`);
    assert.ok(delta.coverage.unsupported.length === 0, `${id}: unsupported ${JSON.stringify(delta.coverage.unsupported)}`);
  }
});

test("T2b-2: неразрешимый импорт → без ребра, без исключения, файл в coverage", async () => {
  const go = adapterById("tree-sitter-go");
  const dir = mkdtempSync(join(tmpdir(), "arch-mcp-go-ghost-"));
  try {
    writeFileSync(
      join(dir, "main.go"),
      'package main\n\nimport "totally/missing/pkg"\n\nfunc main() {}\n',
      "utf8",
    );
    const run = await scan(go, dir); // исключений быть не должно
    assert.equal(run.status, "ok", `status=${run.status} evidence=${JSON.stringify(run.evidence)}`);
    const delta = run.deltas[0];
    assert.ok(delta, "дельта не вернулась");
    const fromGhost = delta.edges.filter((e) => e.source === "main.go");
    assert.deepEqual(fromGhost, [], `неожиданные рёбра от main.go: ${JSON.stringify(fromGhost)}`);
    assert.ok(
      delta.nodes.some((n) => n.id === "main.go"),
      `main.go не учтён: ${JSON.stringify(delta.nodes.map((n) => n.id))}`,
    );
    assert.equal(delta.coverage.files_seen, 1, `files_seen=${delta.coverage.files_seen}`);
    assert.deepEqual(delta.coverage.unsupported, [], "unsupported должен быть пуст");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("T2b-3: битый wasm одного языка → только он not_available, остальные работают, ядро отвечает", async () => {
  assert.ok(existsSync(GRAMMARS), `нет grammars/ — копировать нечего: ${GRAMMARS}`);
  const gtmp = mkdtempSync(join(tmpdir(), "arch-mcp-grammars-lang-"));
  const repo = mkdtempSync(join(tmpdir(), "arch-mcp-badwasm-lang-"));
  const cache = mkdtempSync(join(tmpdir(), "arch-mcp-badwasm-lang-cache-"));
  const savedGrammarDir = process.env.ARCH_MCP_GRAMMAR_DIR;
  try {
    cpSync(GRAMMARS, gtmp, { recursive: true });
    writeFileSync(join(gtmp, "tree-sitter-go.wasm"), "this is definitely not a wasm module", "utf8");

    // Во временный репозиторий копируются фикстуры ВСЕХ языков + манифест.
    cpSync(LANGS, repo, { recursive: true });
    writeFileSync(join(repo, "pyproject.toml"), "[project]\nname = 'badwasm-langs-fixture'\n", "utf8");

    process.env.ARCH_MCP_GRAMMAR_DIR = gtmp;
    // Прогрев (ТЗ v3, п.A): холодный arch_status отдаёт building — поллинг.
    const o = { env: { ...process.env, ARCH_MCP_CACHE_DIR: cache }, cwd: repo };
    let res;
    for (let i = 0; i < 900; i++) {
      res = await lib.runTool("arch_status", { workspace: repo }, o);
      if (res.payload.index.state !== "building") break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    const env = res.payload;
    assert.equal(env.ok, true, "ядро обязано ответить при битом wasm");

    const goEntry = env.index.adapters.find((a) => a.name === "tree-sitter-go");
    assert.ok(goEntry, `tree-sitter-go не в index.adapters: ${JSON.stringify(env.index.adapters)}`);
    assert.equal(goEntry.status, "not_available", `go status=${goEntry.status}`);
    assert.ok(env.index.missing.includes("tree-sitter-go"), `нет в missing[]: ${JSON.stringify(env.index.missing)}`);
    assert.equal(env.index.state, "partial", `state=${env.index.state}`);

    // Остальные 8 языковых адаптеров работают (файлы есть, wasm целые).
    for (const [id] of CASES) {
      if (id === "tree-sitter-go") continue;
      const entry = env.index.adapters.find((a) => a.name === id);
      assert.ok(entry, `${id} не в index.adapters: ${JSON.stringify(env.index.adapters.map((a) => a.name))}`);
      assert.equal(entry.status, "ok", `${id}: status=${entry.status}`);
      assert.ok(!env.index.missing.includes(id), `${id} не должен быть в missing[]`);
    }
  } finally {
    if (savedGrammarDir === undefined) delete process.env.ARCH_MCP_GRAMMAR_DIR;
    else process.env.ARCH_MCP_GRAMMAR_DIR = savedGrammarDir;
    rmSync(gtmp, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
    rmSync(cache, { recursive: true, force: true });
  }
});

test("T2b-4: детерминизм — повторный прогон даёт те же узлы/рёбра/coverage в том же порядке", async () => {
  for (const dirName of ["java", "php"]) {
    const adapter = adapterById(dirName === "java" ? "tree-sitter-java" : "tree-sitter-php");
    const dir = join(LANGS, dirName);
    const a = await scan(adapter, dir);
    const b = await scan(adapter, dir);
    assert.equal(a.status, "ok", `${dirName}: status=${a.status}`);
    assert.equal(b.status, "ok", `${dirName}: status=${b.status}`);
    assert.deepEqual(b.deltas[0].nodes, a.deltas[0].nodes, `${dirName}: узлы/порядок не повторились`);
    assert.deepEqual(b.deltas[0].edges, a.deltas[0].edges, `${dirName}: рёбра/порядок не повторились`);
    assert.deepEqual(b.deltas[0].coverage, a.deltas[0].coverage, `${dirName}: coverage не повторился`);
  }
});

function scipOccurrence(symbol, roles, line, start, end) {
  return create(OccurrenceSchema, {
    symbol,
    symbolRoles: roles,
    typedRange: { case: "singleLineRange", value: { line, startCharacter: start, endCharacter: end } },
  });
}

test("T2b-5: SCIP — .scip через toBinary → symbol-узлы и references-рёбра; файла нет → absent", async () => {
  const scip = adapterById(SCIP_ID);
  const dir = mkdtempSync(join(tmpdir(), "arch-mcp-scip-"));
  const repo = mkdtempSync(join(tmpdir(), "arch-mcp-scip-repo-"));
  const savedScipDir = process.env.ARCH_MCP_SCIP_DIR;
  try {
    const index = create(IndexSchema, {
      metadata: { toolInfo: { name: "scip-fixture", version: "0.0.1" }, projectRoot: "file:///repo/" },
      documents: [
        create(DocumentSchema, {
          relativePath: "src/main.go",
          occurrences: [
            scipOccurrence("example/main.main#", SymbolRole.Definition, 0, 0, 4),
            scipOccurrence("example/helper.run#", 0, 2, 4, 7),
          ],
        }),
        create(DocumentSchema, {
          relativePath: "src/helper.go",
          occurrences: [scipOccurrence("example/helper.run#", SymbolRole.Definition, 0, 0, 3)],
        }),
      ],
    });
    mkdirSync(join(dir), { recursive: true });
    writeFileSync(join(dir, "index.scip"), toBinary(IndexSchema, index));

    // (а) файл найден через ARCH_MCP_SCIP_DIR → symbol + references.
    process.env.ARCH_MCP_SCIP_DIR = dir;
    const run = await scan(scip, repo);
    assert.equal(run.status, "ok", `status=${run.status} evidence=${JSON.stringify(run.evidence)}`);
    const delta = run.deltas[0];
    assert.ok(delta, "дельта не вернулась");

    const syms = delta.nodes.filter((n) => n.kind === "symbol");
    const symIds = syms.map((n) => n.id);
    assert.deepEqual(
      symIds,
      ["symbol:src/helper.go#run", "symbol:src/main.go#main"],
      `symbol-узлы: ${JSON.stringify(symIds)}`,
    );
    const refs = delta.edges.filter((e) => e.kind === "references");
    assert.equal(refs.length, 1, `references-рёбра: ${JSON.stringify(refs)}`);
    assert.equal(refs[0].source, "symbol:src/main.go#main", `source: ${JSON.stringify(refs[0])}`);
    assert.equal(refs[0].target, "symbol:src/helper.go#run", `target: ${JSON.stringify(refs[0])}`);
    assert.equal(refs[0].confidence, "semantic", `confidence: ${JSON.stringify(refs[0])}`);
    const nodeIds = new Set(delta.nodes.map((n) => n.id));
    assert.ok(nodeIds.has(refs[0].target), "цель references не в узлах");
    assert.equal(delta.coverage.files_seen, 1, `files_seen=${delta.coverage.files_seen}`);

    // (б) файла нет → absent (не в index.adapters, не в missing[] — см. envelope).
    delete process.env.ARCH_MCP_SCIP_DIR;
    const none = await scan(scip, repo);
    assert.equal(none.status, "absent", `нет файла → status=${none.status}`);
    assert.deepEqual(none.deltas, [], "absent → дельт нет");
  } finally {
    if (savedScipDir === undefined) delete process.env.ARCH_MCP_SCIP_DIR;
    else process.env.ARCH_MCP_SCIP_DIR = savedScipDir;
    rmSync(dir, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  }
});
