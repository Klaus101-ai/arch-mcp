// T3.2: pyproject.toml читается как TOML (smol-toml), а не регуляркой (ТЗ рев.3 §7; вердикт 6230 MAJOR).
// Тест-план TDD (4 случая):
// (1) [project].dependencies одной строкой с rich[d]==13.6.1 → package:rich, версия 13.6.1, meta.extras=["d"];
// (2) тот же массив многострочный, с обычной зависимостью и extras → обе распознаны;
// (3) [tool.poetry.dependencies] с rich = {version="13.6.1", extras=["d"]} → extras сохранены;
// (4) битый TOML → unsupported, без исключения.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import * as lib from "../dist/lib.mjs";

const manifests = lib.manifestsAdapter;

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

async function scan(root) {
  return lib.runAdapter(manifests, scanCtx(root));
}

function tmpRepo(prefix) {
  return mkdtempSync(join(tmpdir(), `arch-mcp-${prefix}-`));
}

test("T3.2-1: pyproject одной строкой rich[d]==13.6.1 → package:rich, версия 13.6.1, extras=[d]", async () => {
  const dir = tmpRepo("t32-one-line");
  try {
    writeFileSync(
      join(dir, "pyproject.toml"),
      ['[project]', 'name = "demo"', 'version = "0.1.0"', 'dependencies = ["rich[d]==13.6.1"]', ""].join("\n"),
      "utf8",
    );
    const run = await scan(dir);
    assert.equal(run.status, "ok", `status=${run.status}`);
    const delta = run.deltas[0];
    const byId = new Map(delta.nodes.map((n) => [n.id, n]));
    const rich = byId.get("package:rich");
    assert.ok(rich, `нет package:rich: ${JSON.stringify([...byId.keys()])}`);
    assert.equal(rich.kind, "package", "package:rich kind");
    assert.equal(rich.meta?.version, "13.6.1", `версия=${rich.meta?.version}`);
    assert.deepEqual(rich.meta?.extras, ["d"], `extras=${JSON.stringify(rich.meta?.extras)}`);
    assert.ok(
      delta.edges.some((e) => e.kind === "references" && e.source === "pyproject.toml" && e.target === "package:rich"),
      `нет references-ребра pyproject.toml → package:rich: ${JSON.stringify(delta.edges)}`,
    );
    assert.deepEqual(delta.coverage.unsupported, [], `coverage: ${JSON.stringify(delta.coverage)}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("T3.2-2: многострочный массив с обычной зависимостью и extras → обе распознаны", async () => {
  const dir = tmpRepo("t32-multi-line");
  try {
    writeFileSync(
      join(dir, "pyproject.toml"),
      [
        "[project]",
        'name = "demo"',
        "dependencies = [",
        '  "rich[d]==13.6.1",',
        '  "requests>=2",',
        "]",
        "",
      ].join("\n"),
      "utf8",
    );
    const run = await scan(dir);
    assert.equal(run.status, "ok", `status=${run.status}`);
    const delta = run.deltas[0];
    const byId = new Map(delta.nodes.map((n) => [n.id, n]));
    const rich = byId.get("package:rich");
    assert.ok(rich, `нет package:rich: ${JSON.stringify([...byId.keys()])}`);
    assert.equal(rich.meta?.version, "13.6.1", `rich версия=${rich.meta?.version}`);
    assert.deepEqual(rich.meta?.extras, ["d"], `rich extras=${JSON.stringify(rich.meta?.extras)}`);
    const requests = byId.get("package:requests");
    assert.ok(requests, `нет package:requests: ${JSON.stringify([...byId.keys()])}`);
    assert.equal(requests.meta?.version, "2", `requests версия=${requests.meta?.version}`);
    assert.equal(requests.meta?.extras, undefined, "у строки без extras поля нет");
    assert.deepEqual(delta.coverage.unsupported, [], `coverage: ${JSON.stringify(delta.coverage)}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("T3.2-3: poetry-форма rich = {version=\"13.6.1\", extras=[\"d\"]} → extras сохранены", async () => {
  const dir = tmpRepo("t32-poetry");
  try {
    writeFileSync(
      join(dir, "pyproject.toml"),
      [
        "[tool.poetry.dependencies]",
        'python = "^3.11"',
        'rich = {version = "13.6.1", extras = ["d"]}',
        'requests = "2.31.0"',
        "",
      ].join("\n"),
      "utf8",
    );
    const run = await scan(dir);
    assert.equal(run.status, "ok", `status=${run.status}`);
    const delta = run.deltas[0];
    const byId = new Map(delta.nodes.map((n) => [n.id, n]));
    const rich = byId.get("package:rich");
    assert.ok(rich, `нет package:rich: ${JSON.stringify([...byId.keys()])}`);
    assert.equal(rich.meta?.version, "13.6.1", `версия=${rich.meta?.version}`);
    assert.deepEqual(rich.meta?.extras, ["d"], `extras=${JSON.stringify(rich.meta?.extras)}`);
    const requests = byId.get("package:requests");
    assert.ok(requests, `нет package:requests: ${JSON.stringify([...byId.keys()])}`);
    assert.equal(requests.meta?.version, "2.31.0", `requests версия=${requests.meta?.version}`);
    assert.deepEqual(delta.coverage.unsupported, [], `coverage: ${JSON.stringify(delta.coverage)}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("T3.2-4: битый TOML → unsupported в coverage, без исключения", async () => {
  const dir = tmpRepo("t32-broken");
  try {
    writeFileSync(
      join(dir, "pyproject.toml"),
      ['[project', 'name = "demo"', 'dependencies = ["rich[d]==13.6.1"', ""].join("\n"),
      "utf8",
    );
    let run;
    let threw = null;
    try {
      run = await scan(dir);
    } catch (err) {
      threw = err;
    }
    assert.equal(threw, null, `scan не должен бросать исключение: ${threw}`);
    assert.equal(run.status, "ok", `status=${run.status}`);
    const delta = run.deltas[0];
    assert.deepEqual(
      delta.coverage.unsupported,
      ["pyproject.toml"],
      `битый TOML должен уйти в unsupported: ${JSON.stringify(delta.coverage)}`,
    );
    assert.equal(delta.coverage.files_seen, 1, "files_seen");
    assert.equal(delta.coverage.parsed, 0, "parsed — файл не разобран");
    const nonFile = delta.nodes.filter((n) => n.kind !== "file");
    assert.deepEqual(nonFile.map((n) => n.id), [], `узлов вне file-узла должно быть 0: ${JSON.stringify(delta.nodes)}`);
    assert.deepEqual(delta.edges, [], `рёбер должно быть 0: ${JSON.stringify(delta.edges)}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
