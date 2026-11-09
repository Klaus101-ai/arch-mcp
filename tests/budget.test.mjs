import assert from "node:assert/strict";
import { test } from "node:test";
import { enforceBudget } from "../dist/lib.mjs";

function bigPayload(edgeCount) {
  const edges = [];
  const nodes = [];
  for (let i = 0; i < edgeCount; i++) {
    nodes.push(`src/module-${i}.ts`);
    nodes.push(`src/dep-${i}.ts`);
    edges.push({ source: `src/module-${i}.ts`, target: `src/dep-${i}.ts`, type: "require" });
  }
  return {
    nodes: [...new Set(nodes)],
    edges,
    repo: "E:/1_siteteam/asi-agent1",
    evidence: { command: "depcruise", exit_code: 0, stdout: "x".repeat(5000), stderr: "", stdout_bytes: 5000 },
    toolchain: { status: "ok", version: "18.7.0" },
  };
}

test("обрезка по бюджету: payload больше лимита → truncated и размер в пределах лимита", () => {
  const budget = 8 * 1024;
  const result = enforceBudget(bigPayload(2000), budget);
  assert.equal(result.truncated, true);
  const size = Buffer.byteLength(JSON.stringify(result), "utf8");
  assert.ok(size <= budget, `размер ${size} > бюджет ${budget}`);
  assert.ok(result.edges.length > 0, "должна остаться часть рёбер");
  assert.ok(result.edges.length < 2000, "рёбра должны быть усечены");
});

test("обрезка по бюджету: маленький payload не трогается", () => {
  const payload = {
    nodes: ["a", "b"],
    edges: [{ source: "a", target: "b", type: "require" }],
    repo: "r",
    evidence: { command: "c", exit_code: 0, stdout: "", stderr: "", stdout_bytes: 0 },
    toolchain: { status: "ok", version: null },
  };
  const result = enforceBudget(payload, 65_536);
  assert.equal(result.truncated, false);
  assert.equal(result.edges.length, 1);
  assert.equal(result.nodes.length, 2);
});

test("обрезка: evidence тоже ужимается до бюджета", () => {
  const payload = {
    nodes: ["a"],
    edges: [{ source: "a", target: "a", type: "self" }],
    repo: "r",
    evidence: { command: "c", exit_code: 0, stdout: "y".repeat(10_000), stderr: "", stdout_bytes: 10_000 },
    toolchain: { status: "ok", version: null },
  };
  const result = enforceBudget(payload, 4096);
  assert.ok(result.evidence.stdout.length <= 2100, `evidence не ужат: ${result.evidence.stdout.length}`);
  const size = Buffer.byteLength(JSON.stringify(result), "utf8");
  assert.ok(size <= 4096, `размер ${size} > 4096`);
});
