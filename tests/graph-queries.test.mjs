import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import {
  affectedTests,
  focus,
  isTestFile,
  matchNode,
  normalizeDepcruiser,
  normalizeNode,
  reaches,
  resolveInputPath,
  stripColumnMeta,
} from "../dist/lib.mjs";

const fixturePath = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "depcruiser-asi-agent1.json");
const fixture = JSON.parse(readFileSync(fixturePath, "utf8"));
const graph = normalizeDepcruiser(fixture);
const REPO = "E:/1_siteteam/asi-agent1";
const LIMITS = "server/src/limits.ts";

test("фикстура: 226 узлов, нормализация проходит", () => {
  assert.equal(graph.nodes.length, 226, "узлов не 226");
  assert.ok(graph.edges.length > 0, "edges пусты");
});

test("focus(limits.ts): входящие app.ts и limits.test.ts, исходящие пусто", () => {
  const p = focus(graph, REPO, LIMITS);
  assert.deepEqual(
    p.incoming.map((e) => e.source),
    ["server/src/app.ts", "server/tests/limits.test.ts"],
  );
  assert.ok(p.incoming.every((e) => e.type.length > 0), "у связи нет типа");
  assert.deepEqual(p.outgoing, [], "исходящие должны быть пусты");
  assert.deepEqual(p.counts, { incoming: 2, outgoing: 0 });
  assert.equal(p.truncated, false);
  assert.equal(p.node, LIMITS);
});

test("focus: суффиксный ввод limits.ts даёт тот же узел", () => {
  const p = focus(graph, REPO, "limits.ts");
  assert.equal(p.node, LIMITS);
  assert.equal(p.incoming.length, 2);
});

test("focus: limit=1 → обрезка, counts полные", () => {
  const p = focus(graph, REPO, LIMITS, { limit: 1 });
  assert.equal(p.truncated, true, "truncated не стёрт при limit=1");
  assert.equal(p.incoming.length, 1);
  assert.equal(p.counts.incoming, 2, "counts должны быть до обрезки");
  assert.equal(p.limit, 1);
});

test("focus: бюджет ответа (maxBytes) → truncated + подсказка", () => {
  const p = focus(graph, REPO, LIMITS, { maxBytes: 200 });
  assert.equal(p.truncated, true);
  assert.match(String(p.hint), /ARCH_MCP_MAX_RESPONSE_BYTES/);
});

test("reaches: непустой набор, расстояния корректны, сортировка по расстоянию", () => {
  const p = reaches(graph, REPO, LIMITS);
  assert.ok(p.results.length >= 5, `reaches слишком мало: ${p.results.length}`);
  const byName = Object.fromEntries(p.results.map((r) => [r.node, r.distance]));
  assert.equal(byName["server/src/app.ts"], 1, "app.ts должен быть на расстоянии 1");
  assert.equal(byName["server/tests/limits.test.ts"], 1, "limits.test.ts должен быть на расстоянии 1");
  assert.equal(byName["server/src/index.ts"], 2, "index.ts должен быть на расстоянии 2");
  assert.equal(byName["server/tests/chat.test.ts"], 3, "chat.test.ts должен быть на расстоянии 3");
  assert.equal(p.maxDepth, 10, "default maxDepth = 10");
  for (let i = 1; i < p.results.length; i++) {
    assert.ok(p.results[i - 1].distance <= p.results[i].distance, "results не отсортированы по расстоянию");
  }
  assert.ok(!p.results.some((r) => r.node === LIMITS), "цель не входит в результат");
});

test("reaches: maxDepth ограничивает обход", () => {
  const d1 = reaches(graph, REPO, LIMITS, { maxDepth: 1 });
  assert.equal(d1.results.length, 2, "maxDepth=1 → только прямые зависимые");
  assert.ok(d1.results.every((r) => r.distance === 1));
  const d2 = reaches(graph, REPO, LIMITS, { maxDepth: 2 });
  assert.equal(d2.results.length, 5, "maxDepth=2 → 5 узлов");
  assert.ok(d2.results.every((r) => r.distance <= 2));
});

test("reaches: maxDepth 0/отрицательные/нецелые — ошибка валидации", () => {
  assert.throws(() => reaches(graph, REPO, LIMITS, { maxDepth: 0 }), /maxDepth/);
  assert.throws(() => reaches(graph, REPO, LIMITS, { maxDepth: -3 }), /maxDepth/);
  assert.throws(() => reaches(graph, REPO, LIMITS, { maxDepth: 1.5 }), /maxDepth/);
  assert.throws(() => reaches(graph, REPO, LIMITS, { maxDepth: "10" }), /maxDepth/);
});

test("affected_tests(changed=[server/src/limits.ts]) → server/tests/limits.test.ts", () => {
  const p = affectedTests(graph, REPO, [LIMITS]);
  assert.ok(p.tests.includes("server/tests/limits.test.ts"), `нет limits.test.ts: ${p.tests.join(", ")}`);
  assert.ok(p.tests.length > 0, "результат пуст");
  assert.ok(p.tests.every((t) => isTestFile(t)), `не все результаты — тесты: ${p.tests.join(", ")}`);
  assert.deepEqual(p.changed, [LIMITS]);
  assert.equal(p.reason, undefined, "reason должен отсутствовать при непустом результате");
  assert.deepEqual([...p.tests].sort(), p.tests, "tests не отсортированы");
});

test("affected_tests: пустой результат — с причиной и списком проверенных входов", () => {
  // у limits.test.ts нет импортёров → обратное замыкание пусто (кроме самой цели)
  const p = affectedTests(graph, REPO, ["server/tests/limits.test.ts"]);
  assert.deepEqual(p.changed, ["server/tests/limits.test.ts"], "checked-входы должны быть в ответе");
  assert.deepEqual(p.tests, [], "ожидался пустой результат");
  assert.match(String(p.reason), /no test file depends on the changed inputs/);
  assert.match(String(p.reason), /server\/tests\/limits\.test\.ts/, "reason должен перечислять проверенные входы");
});

test("affected_tests: не-массив/пустой changed — ошибка", () => {
  assert.throws(() => affectedTests(graph, REPO, []), /non-empty/);
});

test("нормализация: узел старого кэша ../../1_siteteam/asi-agent1/... → repo-relative", () => {
  assert.equal(normalizeNode("../../1_siteteam/asi-agent1/server/src/limits.ts", REPO), LIMITS);
  assert.equal(normalizeNode("server/src/limits.ts", REPO), LIMITS);
  assert.equal(normalizeNode(".\\server\\src\\limits.ts", REPO), LIMITS);
  const r = resolveInputPath("../../1_siteteam/asi-agent1/server/src/limits.ts", REPO);
  assert.equal(r.status, "ok");
  assert.equal(r.path, LIMITS);
  const abs = resolveInputPath("E:\\1_siteteam\\asi-agent1\\server\\src\\limits.ts", REPO);
  assert.equal(abs.status, "ok");
  assert.equal(abs.path, LIMITS);
});

test("нормализация: dist/ и другие каталоги сборки отсекаются из тестов", () => {
  assert.equal(isTestFile("server/dist/limits.js"), false);
  assert.equal(isTestFile("server/dist/limits.test.js"), false, "тест в dist/ не должен считаться тестом");
  assert.equal(isTestFile("build/x.spec.ts"), false);
  assert.equal(isTestFile(".next/y.test.js"), false);
  assert.equal(isTestFile("coverage/z.test.ts"), false);
  assert.equal(isTestFile("out/w.test.ts"), false);
  assert.equal(isTestFile("server/tests/limits.test.ts"), true);
  assert.equal(isTestFile("test/router-rule.test.mjs"), true);
  assert.equal(isTestFile("src/__tests__/unit.ts"), true);
  assert.equal(isTestFile("tests/test_parser.py"), true);
  assert.equal(isTestFile("src/parser.ts"), false);
});

test("matchNode: ambiguous при >1 совпадения, invalid вне repo и без совпадений", () => {
  const amb = matchNode(LIMITS, REPO, ["server/src/limits.ts", "../../1_siteteam/asi-agent1/server/src/limits.ts"]);
  assert.equal(amb.status, "ambiguous");
  assert.equal(amb.matches.length, 2, "ambiguous должен нести список совпадений");

  const outside = matchNode("E:/other/repo/src/x.ts", REPO, ["server/src/limits.ts"]);
  assert.equal(outside.status, "invalid");
  assert.match(outside.reason, /outside repo/);

  const noMatch = matchNode("server/src/no-such-file.ts", REPO, ["server/src/limits.ts"]);
  assert.equal(noMatch.status, "invalid");
  assert.match(noMatch.reason, /no graph node matches/);

  const ok = matchNode(LIMITS, REPO, ["../../1_siteteam/asi-agent1/server/src/limits.ts"]);
  assert.equal(ok.status, "ok");
  assert.equal(ok.path, LIMITS);
});

// Дельта рев.8, тест-план п.3: columns только в focus
test("focus: columns копируется из meta.columns ребра (пары from/to), у ребра без колонок поля нет", () => {
  const g = {
    nodes: ["a.ts", "b.ts", "c.ts", "d.ts"],
    edges: [
      { source: "a.ts", target: "b.ts", type: "imports", meta: { type_only: false, columns: [{ from: "a.x", to: "b.y" }] } },
      { source: "c.ts", target: "b.ts", type: "imports", meta: { type_only: false } },
      { source: "b.ts", target: "d.ts", type: "calls", meta: { type_only: false, columns: [{ from: "b.f", to: "d.g" }] } },
    ],
  };
  const p = focus(g, REPO, "b.ts");
  const incA = p.incoming.find((e) => e.source === "a.ts");
  const incC = p.incoming.find((e) => e.source === "c.ts");
  assert.deepEqual(incA.columns, [{ from: "a.x", to: "b.y" }], "columns входящего ребра с колонками");
  assert.ok(!("columns" in incC), `у ребра без колонок поля нет: ${JSON.stringify(incC)}`);
  const outD = p.outgoing.find((e) => e.target === "d.ts");
  assert.deepEqual(outD.columns, [{ from: "b.f", to: "d.g" }], "columns исходящего ребра с колонками");
  // сортировка/counts/limit не меняются
  assert.deepEqual(p.counts, { incoming: 2, outgoing: 1 });
  assert.equal(p.truncated, false);
});

// Дельта рев.8, тест-план п.4: режим выключен (default) — прежний граф, без columns
test("focus: дефолтный граф без meta.columns — ни у incoming, ни у outgoing нет поля columns", () => {
  const p = focus(graph, REPO, LIMITS);
  assert.ok(p.incoming.length > 0 && p.outgoing.length >= 0, "фикстура должна давать связи");
  for (const e of [...p.incoming, ...p.outgoing]) {
    assert.ok(!("columns" in e), `поля columns быть не должно: ${JSON.stringify(e)}`);
  }
  // прежний граф не изменился
  assert.equal(graph.nodes.length, 226, "узлы прежнего графа не тронуты");
});

// Дельта рев.8, тест-план п.6: прямой тест стрипа
test("stripColumnMeta: у рёбер только {type_only}, nodes без изменений, исходный граф не мутирован", () => {
  const g = {
    nodes: ["a.ts", "b.ts"],
    edges: [
      { source: "a.ts", target: "b.ts", type: "imports", meta: { type_only: true, columns: [{ from: "a.x", to: "b.y" }] } },
      { source: "b.ts", target: "a.ts", type: "calls", meta: { type_only: false } },
    ],
  };
  const out = stripColumnMeta(g);
  assert.deepEqual(out.nodes, g.nodes, "nodes без изменений");
  assert.deepEqual(out.edges, [
    { source: "a.ts", target: "b.ts", type: "imports", meta: { type_only: true } },
    { source: "b.ts", target: "a.ts", type: "calls", meta: { type_only: false } },
  ], "у рёбер только meta:{type_only}");
  assert.deepEqual(g.edges[0].meta.columns, [{ from: "a.x", to: "b.y" }], "исходный граф не мутирован");
});
