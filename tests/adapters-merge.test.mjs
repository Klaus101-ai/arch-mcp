// T1.2a: слияние GraphDelta (контракт ТЗ рев.3 §6). Тестовый адаптер — заглушка внутри теста.
import assert from "node:assert/strict";
import { test } from "node:test";
import * as lib from "../dist/lib.mjs";

const { mergeDeltas, registerAdapter, listAdapters } = lib;

const stub = (id, priority) => ({
  id,
  version: "0.0.0",
  license: "MIT",
  precision: "syntax",
  priority,
  detect: async () => [],
  scan: async function* () {},
});

const mkDelta = (nodes = [], edges = [], coverage = { files_seen: 0, parsed: 0, unsupported: [] }) => ({
  nodes,
  edges,
  coverage,
});

test("реестр: регистрация адаптера и listAdapters", () => {
  registerAdapter(stub("reg-merge-1", 3));
  const found = listAdapters().find((a) => a.id === "reg-merge-1");
  assert.ok(found, "зарегистрированный адаптер виден в listAdapters");
  assert.equal(found.version, "0.0.0");
  assert.equal(found.priority, 3);
});

test("слияние: одно ребро от двух адаптеров → одно, побеждает больший priority", () => {
  const hi = stub("alpha-hi", 10);
  const lo = stub("beta-lo", 5);
  const edge = (line, from) => ({
    source: "file:a.ts",
    target: "file:b.ts",
    kind: "imports",
    line,
    confidence: "syntax",
    meta: { from },
  });
  const node = (id, source) => ({ id, kind: "file", source });
  const dHi = mkDelta([node("file:a.ts", "alpha-hi")], [edge(10, "alpha-hi")], {
    files_seen: 1,
    parsed: 1,
    unsupported: [],
  });
  const dLo = mkDelta([node("file:a.ts", "beta-lo")], [edge(20, "beta-lo")], {
    files_seen: 1,
    parsed: 1,
    unsupported: [],
  });

  // MINOR 5531 (критик): победитель подаётся ВТОРЫМ — кейс не слепой к порядку:
  // при правиле «побеждает первый» проигравший (line 20) стоял бы первым и тест краснел.
  const res = mergeDeltas([
    { adapter: lo, delta: dLo },
    { adapter: hi, delta: dHi },
  ]);

  assert.equal(res.edges.length, 1, "ребро сливается в одно");
  assert.equal(res.edges[0].line, 10, "побеждает больший priority, а не первый по порядку");
  assert.deepEqual(res.edges[0].meta.adapters, ["alpha-hi", "beta-lo"], "meta.adapters — все отдавшие адаптеры");
  assert.equal(res.nodes.length, 1, "узел сливается по id");
  assert.equal(res.nodes[0].source, "alpha-hi", "узел-победитель — больший priority");
  assert.deepEqual(res.nodes[0].meta.adapters, ["alpha-hi", "beta-lo"]);
  assert.deepEqual(res.contributors, ["alpha-hi", "beta-lo"], "contributors отсортированы");
});

test("MINOR: точный дубль внутри адаптера — с учётом confidence и канонического хэша meta", () => {
  const a = stub("dup-a", 5);
  const base = {
    source: "file:s.ts",
    target: "file:t.ts",
    kind: "imports",
    file: "file:s.ts",
    line: 7,
    confidence: "syntax",
  };
  const one = { ...base, meta: { note: "one" } };
  const two = { ...base, meta: { note: "two" }, confidence: "semantic" };
  const res = mergeDeltas([{ adapter: a, delta: mkDelta([], [one, two]) }]);
  assert.equal(res.edges.length, 2, "одинаковые source/target/kind/file/line, разные meta/confidence → два ребра");

  const exactCopy = mergeDeltas([{ adapter: a, delta: mkDelta([], [one, { ...one }]) }]);
  assert.equal(exactCopy.edges.length, 1, "полный дубль схлопывается");

  const reordered = mergeDeltas([
    { adapter: a, delta: mkDelta([], [{ ...base, meta: { x: 1, y: 2 } }, { ...base, meta: { y: 2, x: 1 } }]) },
  ]);
  assert.equal(reordered.edges.length, 1, "канонический хэш meta не зависит от порядка ключей");
});

test("type-only и value ребро между той же парой сохраняются раздельно", () => {
  const a = stub("type-adapter", 5);
  const valueEdge = {
    source: "file:x.ts",
    target: "file:y.ts",
    kind: "imports",
    confidence: "syntax",
  };
  const typeEdge = {
    source: "file:x.ts",
    target: "file:y.ts",
    kind: "imports",
    confidence: "syntax",
    meta: { type_only: true },
  };
  const res = mergeDeltas([{ adapter: a, delta: mkDelta([], [valueEdge, typeEdge]) }]);
  assert.equal(res.edges.length, 2, "type-only и value рёбра не схлопываются");
  const flags = res.edges.map((e) => e.meta?.type_only === true).sort();
  assert.deepEqual(flags, [false, true]);
});

test("равный priority → tie-break по adapter.id лексикографически", () => {
  const bbb = stub("bbb", 7);
  const aaa = stub("aaa", 7);
  const edge = (line) => ({
    source: "file:s.ts",
    target: "file:t.ts",
    kind: "calls",
    line,
    confidence: "semantic",
  });
  const res = mergeDeltas([
    { adapter: bbb, delta: mkDelta([], [edge(100)]) },
    { adapter: aaa, delta: mkDelta([], [edge(1)]) },
  ]);
  assert.equal(res.edges.length, 1);
  assert.equal(res.edges[0].line, 1, "побеждает меньший adapter.id (aaa)");
  assert.deepEqual(res.edges[0].meta.adapters, ["aaa", "bbb"]);
});

test("coverage агрегируется детерминированно, узлы дедуп по id", () => {
  const hi = stub("cov-hi", 10);
  const lo = stub("cov-lo", 5);
  const dHi = mkDelta(
    [
      { id: "file:z.ts", kind: "file", source: "cov-hi" },
      { id: "file:m.ts", kind: "file", source: "cov-hi" },
    ],
    [],
    { files_seen: 5, parsed: 3, unsupported: ["z.ts", "a.ts"] },
  );
  const dLo = mkDelta(
    [
      { id: "file:m.ts", kind: "file", source: "cov-lo" },
      { id: "file:a.ts", kind: "file", source: "cov-lo" },
    ],
    [],
    { files_seen: 9, parsed: 7, unsupported: ["a.ts", "b.ts"] },
  );
  const res = mergeDeltas([
    { adapter: hi, delta: dHi },
    { adapter: lo, delta: dLo },
  ]);

  assert.deepEqual(res.coverage, {
    files_seen: 9,
    parsed: 7,
    unsupported: ["a.ts", "b.ts", "z.ts"],
  });
  assert.deepEqual(
    res.nodes.map((n) => n.id),
    ["file:a.ts", "file:m.ts", "file:z.ts"],
    "узлы отсортированы по id, дедуп по id",
  );
  const shared = res.nodes.find((n) => n.id === "file:m.ts");
  assert.equal(shared.source, "cov-hi", "побеждает больший priority");
  assert.deepEqual(shared.meta.adapters, ["cov-hi", "cov-lo"]);
});
