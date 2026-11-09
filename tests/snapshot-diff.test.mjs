import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import {
  ArchMcpError,
  cacheRoot,
  diffSnapshots,
  loadSnapshotByHead,
  loadSnapshotById,
  resolveSnapshotRef,
  saveSnapshot,
  snapshotId,
} from "../dist/lib.mjs";

const WS = "E:/test/repo";
const ADAPTERS = { depcruiser: "18.7.0", package: "0.1.0", schema: "graph-2" };

function graphA() {
  return {
    nodes: ["a.ts", "b.ts"],
    edges: [{ source: "a.ts", target: "b.ts", type: "import", meta: { type_only: false } }],
  };
}

function graphB() {
  return {
    nodes: ["a.ts", "b.ts", "c.ts"],
    edges: [
      { source: "a.ts", target: "b.ts", type: "import", meta: { type_only: false } },
      { source: "c.ts", target: "a.ts", type: "import", meta: { type_only: false } },
    ],
  };
}

test("snapshotId: стабильный sha256, порядок узлов/рёбер не важен, HEAD/адаптеры/граф влияют", () => {
  const g = graphA();
  const id1 = snapshotId({ graph: g, gitHead: "h1", adapters: ADAPTERS });
  assert.match(id1, /^[0-9a-f]{64}$/);

  const shuffled = { nodes: ["b.ts", "a.ts"], edges: [g.edges[0]] };
  assert.equal(snapshotId({ graph: shuffled, gitHead: "h1", adapters: ADAPTERS }), id1, "порядок не должен менять id");

  assert.notEqual(snapshotId({ graph: g, gitHead: "h2", adapters: ADAPTERS }), id1, "HEAD влияет на id");
  assert.notEqual(
    snapshotId({ graph: g, gitHead: "h1", adapters: { ...ADAPTERS, depcruiser: "18.7.1" } }),
    id1,
    "версия адаптера влияет на id",
  );
  assert.notEqual(snapshotId({ graph: graphB(), gitHead: "h1", adapters: ADAPTERS }), id1, "граф влияет на id");
});

test("save/load: снимок по id и по HEAD, промах → null", () => {
  const cache = mkdtempSync(join(tmpdir(), "arch-mcp-snap-"));
  try {
    const head = "a".repeat(40);
    const snap = {
      snapshot_id: snapshotId({ graph: graphA(), gitHead: head, adapters: ADAPTERS }),
      workspace: WS,
      git_head: head,
      ts: "2026-11-02T00:00:00.000Z",
      graph: graphA(),
      adapters: ADAPTERS,
    };
    saveSnapshot(cache, snap);
    assert.equal(loadSnapshotById(cache, WS, snap.snapshot_id)?.snapshot_id, snap.snapshot_id);
    assert.equal(loadSnapshotByHead(cache, WS, head)?.snapshot_id, snap.snapshot_id, "маппинг HEAD → снимок");
    assert.equal(loadSnapshotById(cache, WS, "f".repeat(64)), null, "неизвестный id → null");
    assert.equal(loadSnapshotByHead(cache, WS, "b".repeat(40)), null, "неизвестный HEAD → null");
    assert.equal(loadSnapshotById(cache, "E:/other/repo", snap.snapshot_id), null, "кэш изолирован по workspace");
  } finally {
    rmSync(cache, { recursive: true, force: true });
  }
});

test("resolveSnapshotRef: current строит снимок, id/HEAD читаются из кэша", async () => {
  const cache = mkdtempSync(join(tmpdir(), "arch-mcp-ref-"));
  try {
    const head = "c".repeat(40);
    const stored = {
      snapshot_id: snapshotId({ graph: graphA(), gitHead: head, adapters: ADAPTERS }),
      workspace: WS,
      git_head: head,
      ts: "2026-11-02T00:00:00.000Z",
      graph: graphA(),
      adapters: ADAPTERS,
    };
    saveSnapshot(cache, stored);

    let built = 0;
    const ctx = {
      cacheRoot: cache,
      workspace: WS,
      buildCurrent: async () => {
        built += 1;
        return {
          snapshot_id: snapshotId({ graph: graphB(), gitHead: "d".repeat(40), adapters: ADAPTERS }),
          workspace: WS,
          git_head: "d".repeat(40),
          ts: "2026-11-02T01:00:00.000Z",
          graph: graphB(),
          adapters: ADAPTERS,
        };
      },
    };

    const cur = await resolveSnapshotRef("current", ctx);
    assert.equal(cur.side.ref, "current");
    assert.equal(built, 1, "current должен строить снимок");
    assert.equal(cur.snapshot.graph.nodes.length, 3);

    const byId = await resolveSnapshotRef(stored.snapshot_id, ctx);
    assert.equal(byId.snapshot.snapshot_id, stored.snapshot_id);
    assert.equal(built, 1, "по id снимок не перестраивается");

    const byHead = await resolveSnapshotRef(head, ctx);
    assert.equal(byHead.snapshot.snapshot_id, stored.snapshot_id);
    assert.equal(byHead.side.git_head, head);
  } finally {
    rmSync(cache, { recursive: true, force: true });
  }
});

test("resolveSnapshotRef: нет снимка → SNAPSHOT_NOT_FOUND, неверный формат → INVALID_ARGUMENT", async () => {
  const cache = mkdtempSync(join(tmpdir(), "arch-mcp-ref2-"));
  try {
    const ctx = { cacheRoot: cache, workspace: WS, buildCurrent: async () => { throw new Error("не должен строиться"); } };
    for (const [ref, code] of [
      ["e".repeat(64), "SNAPSHOT_NOT_FOUND"],
      ["e".repeat(40), "SNAPSHOT_NOT_FOUND"],
      ["HEAD~1", "INVALID_ARGUMENT"],
      ["", "INVALID_ARGUMENT"],
      [undefined, "INVALID_ARGUMENT"],
      ["not-a-ref!", "INVALID_ARGUMENT"],
    ]) {
      try {
        await resolveSnapshotRef(ref, ctx);
        assert.fail(`ref=${JSON.stringify(ref)}: ошибка не брошена`);
      } catch (err) {
        assert.ok(err instanceof ArchMcpError, `ref=${JSON.stringify(ref)}: не ArchMcpError`);
        assert.equal(err.code, code, `ref=${JSON.stringify(ref)}: код ${err.code}`);
      }
    }
  } finally {
    rmSync(cache, { recursive: true, force: true });
  }
});

test("diffSnapshots: добавленные/удалённые узлы и рёбра, type-only смена считается изменением ребра", () => {
  const from = { snapshot_id: "i".repeat(64), workspace: WS, git_head: "h1", ts: "t", graph: graphA(), adapters: ADAPTERS };
  const to = { snapshot_id: "j".repeat(64), workspace: WS, git_head: "h2", ts: "t", graph: graphB(), adapters: ADAPTERS };

  const d = diffSnapshots(from, to, WS, {});
  assert.deepEqual(d.added_nodes, ["c.ts"]);
  assert.deepEqual(d.removed_nodes, []);
  assert.equal(d.added_edges.length, 1);
  assert.equal(d.added_edges[0].source, "c.ts");
  assert.deepEqual(d.removed_edges, []);
  assert.deepEqual(d.counts, { added_nodes: 1, removed_nodes: 0, added_edges: 1, removed_edges: 0 });
  assert.equal(d.truncated, false);
  assert.equal(d.from.snapshot_id, "i".repeat(64));
  assert.equal(d.to.snapshot_id, "j".repeat(64));

  const back = diffSnapshots(to, from, WS, {});
  assert.deepEqual(back.removed_nodes, ["c.ts"]);
  assert.equal(back.removed_edges.length, 1);
  assert.deepEqual(back.counts, { added_nodes: 0, removed_nodes: 1, added_edges: 0, removed_edges: 1 });

  // смена type_only того же ребра — это удаление+добавление ребра
  const toTyped = {
    ...to,
    graph: { nodes: graphA().nodes, edges: [{ source: "a.ts", target: "b.ts", type: "import", meta: { type_only: true } }] },
  };
  const d2 = diffSnapshots(from, toTyped, WS, {});
  assert.equal(d2.added_edges.length, 1, "type-only ребро — новое ребро");
  assert.equal(d2.removed_edges.length, 1, "старое ребро — удалено");
  assert.equal(d2.added_edges[0].type_only, true);
});

test("diffSnapshots: бюджет max_bytes → truncated + hint", () => {
  const many = { nodes: [], edges: [] };
  for (let i = 0; i < 60; i++) {
    many.nodes.push(`m${i}.ts`);
    many.edges.push({ source: `m${i}.ts`, target: `m${i + 1}.ts`, type: "import", meta: { type_only: false } });
  }
  const from = { snapshot_id: "i".repeat(64), workspace: WS, git_head: "h1", ts: "t", graph: { nodes: [], edges: [] }, adapters: ADAPTERS };
  const to = { snapshot_id: "j".repeat(64), workspace: WS, git_head: "h2", ts: "t", graph: many, adapters: ADAPTERS };
  const d = diffSnapshots(from, to, WS, { maxBytes: 500 });
  assert.equal(d.truncated, true);
  assert.match(String(d.hint), /ARCH_MCP_MAX_RESPONSE_BYTES|max_bytes/);
  assert.ok(d.added_nodes.length < 61, "список должен быть усечён");
});

test("cacheRoot: ARCH_MCP_CACHE_DIR переопределяет, дефолт — %LOCALAPPDATA%/arch-mcp/cache", () => {
  const override = "E:\\1_Products\\arch-mcp\\.cache";
  assert.equal(resolve(cacheRoot({ ARCH_MCP_CACHE_DIR: override })), resolve(override));
  const def = cacheRoot({});
  assert.ok(def.replace(/\\/g, "/").endsWith("arch-mcp/cache"), `дефолт кэша: ${def}`);
  assert.ok(cacheRoot({ ARCH_MCP_CACHE_DIR: "   " }) === def, "пробелы → дефолт");
});
