import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { extractCircles, normalizeDepcruiser } from "../dist/lib.mjs";

const fixturePath = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "depcruiser-asi-agent1.json");
const fixture = JSON.parse(readFileSync(fixturePath, "utf8"));

test("нормализация depcruiser JSON (реальный прогон asi-agent1): nodes и edges непустые", () => {
  const { nodes, edges } = normalizeDepcruiser(fixture);
  assert.ok(nodes.length > 0, "nodes пусты");
  assert.ok(edges.length > 0, "edges пусты");
});

test("нормализация: каждая edge имеет {source, target, type}", () => {
  const { edges } = normalizeDepcruiser(fixture);
  for (const e of edges.slice(0, 50)) {
    assert.equal(typeof e.source, "string");
    assert.equal(typeof e.target, "string");
    assert.equal(typeof e.type, "string");
    assert.ok(e.source.length > 0 && e.target.length > 0);
  }
});

test("нормализация: nodes покрывают все endpoints, без дублей", () => {
  const { nodes, edges } = normalizeDepcruiser(fixture);
  const set = new Set(nodes);
  assert.equal(set.size, nodes.length, "дубли в nodes");
  for (const e of edges) {
    assert.ok(set.has(e.source), `нет узла ${e.source}`);
    assert.ok(set.has(e.target), `нет узла ${e.target}`);
  }
});

test("extractCircles: возвращает массив пар", () => {
  const circles = extractCircles(fixture);
  assert.ok(Array.isArray(circles));
  for (const c of circles) {
    assert.equal(typeof c.source, "string");
    assert.equal(typeof c.target, "string");
  }
});
