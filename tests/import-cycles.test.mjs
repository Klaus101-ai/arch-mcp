// T5.1 (вердикт критика 6471-6477, MINOR 1): import-граф src без цикла
// core/adapters/depcruiser-adapter.ts ↔ tools/get_graph.ts.
// registry.ts:2-3 утверждает «циклов нет» — тест охраняет это утверждение
// хотя бы для пары depcruiser-adapter ↔ get_graph.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

const SRC = path.resolve("src");
const START = path.join(SRC, "core", "adapters", "depcruiser-adapter.ts");
const TARGET = path.join(SRC, "tools", "get_graph.ts");

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(p));
    else if (entry.name.endsWith(".ts")) out.push(p);
  }
  return out;
}

/** Статические import/export-from specifier'ы модуля (включая type-only). */
function importSpecifiers(file) {
  const text = readFileSync(file, "utf8");
  const specs = [];
  const re = /(?:^|\n)\s*(?:import|export)[^"'\n]*?from\s*["']([^"']+)["']/g;
  let m;
  while ((m = re.exec(text)) !== null) specs.push(m[1]);
  const side = /(?:^|\n)\s*import\s*["']([^"']+)["']/g;
  while ((m = side.exec(text)) !== null) specs.push(m[1]);
  return specs;
}

function buildGraph() {
  const graph = new Map();
  for (const file of walk(SRC)) {
    const edges = [];
    for (const spec of importSpecifiers(file)) {
      if (!spec.startsWith(".")) continue;
      let resolved = path.resolve(path.dirname(file), spec);
      if (!resolved.endsWith(".ts") && !resolved.endsWith(".mjs") && !resolved.endsWith(".js")) resolved += ".ts";
      edges.push(resolved);
    }
    graph.set(file, edges);
  }
  return graph;
}

function reachable(graph, from, to) {
  const seen = new Set([from]);
  const queue = [from];
  while (queue.length > 0) {
    const cur = queue.shift();
    if (cur === to && cur !== from) return true;
    for (const next of graph.get(cur) ?? []) {
      if (next === to) return true;
      if (!seen.has(next)) {
        seen.add(next);
        queue.push(next);
      }
    }
  }
  return false;
}

test("depcruiser-adapter не импортирует (в т.ч. транзитивно) tools/get_graph — цикла нет", () => {
  const graph = buildGraph();
  assert.ok(graph.has(START), `нет файла в графе: ${START}`);
  assert.ok(graph.has(TARGET), `нет файла в графе: ${TARGET}`);
  const pathExists = reachable(graph, START, TARGET);
  assert.equal(
    pathExists,
    false,
    "импорт-путь src/core/adapters/depcruiser-adapter.ts → src/tools/get_graph.ts замыкает цикл " +
      "(get_graph → registry → depcruiser-adapter → get_graph), registry.ts:2-3 утверждает «циклов нет»",
  );
});
