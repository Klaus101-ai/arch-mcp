import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import {
  ArchMcpError,
  affectedTests,
  focus,
  impact,
  normalizeDepcruiser,
  reaches,
  search,
} from "../dist/lib.mjs";

const REPO = "E:/1_siteteam/asi-agent1";
const LIMITS = "server/src/limits.ts";

/** Синтетический граф, повторяющий живые числа приёмки ТЗ (chat.ts/lead.ts — type-only). */
function makeGraph() {
  const raw = {
    modules: [
      { source: "server/src/limits.ts", dependencies: [] },
      { source: "server/src/app.ts", dependencies: [{ resolved: "server/src/limits.ts", dependencyTypes: ["local", "import"] }] },
      { source: "server/tests/limits.test.ts", dependencies: [{ resolved: "server/src/limits.ts", dependencyTypes: ["local", "import"] }] },
      { source: "server/src/chat.ts", dependencies: [{ resolved: "server/src/limits.ts", dependencyTypes: ["type-only"] }] },
      { source: "server/src/lead.ts", dependencies: [{ resolved: "server/src/limits.ts", dependencyTypes: ["type-only"] }] },
      { source: "server/src/index.ts", dependencies: [{ resolved: "server/src/app.ts", dependencyTypes: ["local", "import"] }] },
      { source: "server/tests/helpers.ts", dependencies: [{ resolved: "server/src/app.ts", dependencyTypes: ["local", "import"] }] },
      { source: "server/tests/server.test.ts", dependencies: [{ resolved: "server/src/app.ts", dependencyTypes: ["local", "import"] }] },
      { source: "server/tests/chat.test.ts", dependencies: [{ resolved: "server/tests/helpers.ts", dependencyTypes: ["local", "import"] }] },
      { source: "server/tests/cors.test.ts", dependencies: [{ resolved: "server/tests/helpers.ts", dependencyTypes: ["local", "import"] }] },
      { source: "server/tests/health.test.ts", dependencies: [{ resolved: "server/tests/helpers.ts", dependencyTypes: ["local", "import"] }] },
      { source: "server/tests/lead.test.ts", dependencies: [{ resolved: "server/tests/helpers.ts", dependencyTypes: ["local", "import"] }] },
    ],
  };
  return normalizeDepcruiser(raw);
}

const graph = makeGraph();

const fixturePath = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "depcruiser-asi-agent1.json");
const fixture = normalizeDepcruiser(JSON.parse(readFileSync(fixturePath, "utf8")));

test("normalizeDepcruiser: type-only → meta.type_only=true, обычное ребро → false", () => {
  const byTarget = (t) => graph.edges.filter((e) => e.target === t);
  const toLimits = byTarget("server/src/limits.ts");
  assert.equal(toLimits.length, 4, "в limits.ts входят 4 ребра");
  const metaOf = (source) => toLimits.find((e) => e.source === source).meta;
  assert.equal(metaOf("server/src/chat.ts").type_only, true);
  assert.equal(metaOf("server/src/lead.ts").type_only, true);
  assert.equal(metaOf("server/src/app.ts").type_only, false);
  assert.equal(metaOf("server/tests/limits.test.ts").type_only, false);
  for (const e of graph.edges) assert.equal(typeof e.meta.type_only, "boolean", "meta.type_only обязателен у всех рёбер");
});

test("focus: по умолчанию type-only исключены (2 incoming), include_type_only=true → 4 (chat.ts, lead.ts)", () => {
  const def = focus(graph, REPO, LIMITS);
  assert.deepEqual(def.incoming.map((e) => e.source), ["server/src/app.ts", "server/tests/limits.test.ts"]);
  assert.equal(def.counts.incoming, 2);
  assert.equal(def.include_type_only, false);

  const withTo = focus(graph, REPO, LIMITS, { include_type_only: true });
  assert.deepEqual(withTo.incoming.map((e) => e.source), [
    "server/src/app.ts",
    "server/src/chat.ts",
    "server/src/lead.ts",
    "server/tests/limits.test.ts",
  ]);
  assert.equal(withTo.counts.incoming, 4);
  assert.equal(withTo.include_type_only, true);
});

test("reaches: default 9, include_type_only=true → 11 (появляются chat.ts и lead.ts)", () => {
  const def = reaches(graph, REPO, LIMITS);
  assert.equal(def.results.length, 9, `default reaches != 9: ${def.results.length}`);
  assert.equal(def.include_type_only, false);

  const withTo = reaches(graph, REPO, LIMITS, { include_type_only: true });
  assert.ok(withTo.results.length >= 11, `reaches с type-only < 11: ${withTo.results.length}`);
  const names = withTo.results.map((r) => r.node);
  assert.ok(names.includes("server/src/chat.ts"), "chat.ts нет в reachable");
  assert.ok(names.includes("server/src/lead.ts"), "lead.ts нет в reachable");
});

test("affected_tests: default 6 с limits.test.ts; include_type_only=true не меньше", () => {
  const def = affectedTests(graph, REPO, [LIMITS]);
  assert.equal(def.tests.length, 6, `affected_tests != 6: ${def.tests.length}`);
  assert.ok(def.tests.includes("server/tests/limits.test.ts"));
  assert.equal(def.include_type_only, false);

  const withTo = affectedTests(graph, REPO, [LIMITS], { include_type_only: true });
  assert.ok(withTo.tests.length >= 6);
  assert.ok(withTo.include_type_only);
});

test("фикстура: type-only нет → оба режима дают одинаковые числа (2 incoming, 9 reaches)", () => {
  const defFocus = focus(fixture, REPO, LIMITS);
  const toFocus = focus(fixture, REPO, LIMITS, { include_type_only: true });
  assert.equal(defFocus.counts.incoming, 2);
  assert.equal(toFocus.counts.incoming, 2, "в фикстуре type-only рёбер нет");
  assert.equal(reaches(fixture, REPO, LIMITS).results.length, 9);
  assert.equal(reaches(fixture, REPO, LIMITS, { include_type_only: true }).results.length, 9);
});

test("impact: обратная достижимость по changed[], depth, без эпицентра, сортировка", () => {
  const p = impact(graph, REPO, [LIMITS]);
  assert.deepEqual(p.changed, [LIMITS]);
  assert.equal(p.depth, 10, "default depth = 10");
  assert.equal(p.include_type_only, false);
  assert.equal(p.results.length, 9, `impact default != 9: ${p.results.length}`);
  assert.ok(!p.results.some((r) => r.node === LIMITS), "эпицентр исключён");
  for (let i = 1; i < p.results.length; i++) {
    assert.ok(p.results[i - 1].distance <= p.results[i].distance, "не отсортировано по расстоянию");
  }

  const d1 = impact(graph, REPO, [LIMITS], { depth: 1 });
  assert.equal(d1.results.length, 2, "depth=1 → только прямые зависимые");
  assert.ok(d1.results.every((r) => r.distance === 1));

  const withTo = impact(graph, REPO, [LIMITS], { include_type_only: true });
  assert.ok(withTo.results.length >= 11, `impact с type-only < 11: ${withTo.results.length}`);
});

test("impact: depth 0/отрицательные/нецелые → INVALID_ARGUMENT", () => {
  for (const bad of [0, -1, 1.5, "3"]) {
    try {
      impact(graph, REPO, [LIMITS], { depth: bad });
      assert.fail(`ожидался INVALID_ARGUMENT для depth=${JSON.stringify(bad)}`);
    } catch (err) {
      assert.ok(err instanceof ArchMcpError, `${JSON.stringify(bad)}: не ArchMcpError`);
      assert.equal(err.code, "INVALID_ARGUMENT", `${JSON.stringify(bad)}: код ${err.code}`);
      assert.match(String(err.message), /depth/);
    }
  }
});

test("impact: не-массив/пустой changed → INVALID_ARGUMENT", () => {
  for (const bad of [[], "x", [1]]) {
    try {
      impact(graph, REPO, bad);
      assert.fail("ожидался INVALID_ARGUMENT");
    } catch (err) {
      assert.ok(err instanceof ArchMcpError);
      assert.equal(err.code, "INVALID_ARGUMENT");
      assert.match(String(err.message), /changed/);
    }
  }
});

test("search: находит limits.ts, виды file/dir/test, регистронезависимость", () => {
  const p = search(fixture, REPO, "limits");
  assert.ok(p.count > 0, "ничего не найдено");
  assert.ok(p.matches.some((m) => m.node === LIMITS), `нет ${LIMITS}: ${p.matches.map((m) => m.node).join(", ")}`);
  assert.ok(p.matches.every((m) => m.kind === "file" || m.kind === "test"));
  assert.equal(p.kind, "file");

  const ci = search(fixture, REPO, "LIMITS");
  assert.equal(ci.count, p.count, "регистр не должен менять число совпадений");

  const testsOnly = search(fixture, REPO, "limits", { kind: "test" });
  assert.ok(testsOnly.count >= 1);
  assert.ok(testsOnly.matches.every((m) => m.kind === "test"));
  assert.ok(testsOnly.matches.some((m) => m.node === "server/tests/limits.test.ts"));

  const dirs = search(fixture, REPO, "server/src", { kind: "dir" });
  assert.ok(dirs.matches.some((m) => m.node === "server/src"), `нет server/src: ${dirs.matches.map((m) => m.node).join(", ")}`);
  assert.ok(dirs.matches.every((m) => m.kind === "dir"));

  assert.equal(p.truncated, false);
});

test("search: пустой запрос → INVALID_ARGUMENT, нет совпадений → count 0 без ошибки", () => {
  try {
    search(fixture, REPO, "   ");
    assert.fail("ожидался INVALID_ARGUMENT");
  } catch (err) {
    assert.ok(err instanceof ArchMcpError);
    assert.equal(err.code, "INVALID_ARGUMENT");
    assert.match(String(err.message), /query/);
  }
  const none = search(fixture, REPO, "no-such-module-xyz-42");
  assert.equal(none.count, 0);
  assert.deepEqual(none.matches, []);
  assert.equal(none.truncated, false);
});

test("search: бюджет max_bytes → truncated + hint", () => {
  const p = search(fixture, REPO, "server", { maxBytes: 400 });
  assert.equal(p.truncated, true);
  assert.ok(p.matches.length < p.count || p.count > 0, "обрезка должна сократить matches");
  assert.match(String(p.hint), /ARCH_MCP_MAX_RESPONSE_BYTES|budget/i);
});
