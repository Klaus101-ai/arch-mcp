// T1.2a: слияние дельт адаптеров (контракт ТЗ рев.3 §6).
// Детерминизм: узлы по id, рёбра по source|target|kind|type_only;
// межадаптерный конфликт по ключу — больший priority, при равном — меньший adapter.id.
import type { Adapter, GraphDelta, GraphEdge, GraphNode } from "./types.ts";

type Coverage = { files_seen: number; parsed: number; unsupported: string[] };

/** a строже побеждает b: больший priority, при равном — лексикографически меньший id. */
function beats(a: Adapter, b: Adapter): boolean {
  if (a.priority !== b.priority) return a.priority > b.priority;
  return a.id < b.id;
}

function cmpStr(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Канонический JSON: ключи объектов сортируются — хэш meta не зависит от порядка записи. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => cmpStr(a, b));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/** Ключ ребра: (source, target, kind, type_only); type_only = meta?.type_only === true. */
function edgeKeyOf(edge: GraphEdge): string {
  return JSON.stringify([edge.source, edge.target, edge.kind, edge.meta?.type_only === true]);
}

export function mergeDeltas(deltas: Array<{ adapter: Adapter; delta: GraphDelta }>): {
  nodes: GraphNode[];
  edges: GraphEdge[];
  coverage: Coverage;
  contributors: string[];
} {
  const contributors = [...new Set(deltas.map((d) => d.adapter.id))].sort();

  // Coverage: files_seen и parsed — максимум, unsupported — отсортированное объединение.
  let filesSeen = 0;
  let parsed = 0;
  const unsupported = new Set<string>();
  for (const { delta } of deltas) {
    filesSeen = Math.max(filesSeen, delta.coverage.files_seen);
    parsed = Math.max(parsed, delta.coverage.parsed);
    for (const u of delta.coverage.unsupported) unsupported.add(u);
  }

  // Узлы: дедуп по id, победитель — больший priority (при равном — меньший id).
  const nodeWinner = new Map<string, { node: GraphNode; adapter: Adapter }>();
  const nodeAdapters = new Map<string, Set<string>>();
  for (const { adapter, delta } of deltas) {
    for (const node of delta.nodes) {
      const ids = nodeAdapters.get(node.id) ?? new Set<string>();
      ids.add(adapter.id);
      nodeAdapters.set(node.id, ids);
      const cur = nodeWinner.get(node.id);
      if (!cur || beats(adapter, cur.adapter)) nodeWinner.set(node.id, { node, adapter });
    }
  }
  const nodes = [...nodeWinner.entries()]
    .map(([id, { node }]) => ({
      ...node,
      meta: { ...(node.meta ?? {}), adapters: [...(nodeAdapters.get(id) ?? [])].sort() },
    }))
    .sort((a, b) => cmpStr(a.id, b.id));

  // Рёбра: точные дубли внутри одного адаптера (ключ + file/line + confidence +
  // канонический хэш meta) схлопываются; межадаптерно по ключу побеждает
  // больший priority, при равном — меньший id.
  const seenExact = new Set<string>();
  const byKey = new Map<string, Array<{ edge: GraphEdge; adapter: Adapter }>>();
  for (const { adapter, delta } of deltas) {
    for (const edge of delta.edges) {
      const key = edgeKeyOf(edge);
      const exact = JSON.stringify([
        adapter.id,
        key,
        edge.file ?? null,
        edge.line ?? null,
        edge.confidence,
        canonicalJson(edge.meta ?? {}),
      ]);
      if (seenExact.has(exact)) continue;
      seenExact.add(exact);
      const list = byKey.get(key) ?? [];
      list.push({ edge, adapter });
      byKey.set(key, list);
    }
  }

  const outEdges: Array<{ sortKey: string; edge: GraphEdge }> = [];
  for (const list of byKey.values()) {
    let winner = list[0].adapter;
    const ids = new Set<string>();
    for (const { adapter } of list) {
      ids.add(adapter.id);
      if (beats(adapter, winner)) winner = adapter;
    }
    const adapters = [...ids].sort();
    for (const { edge, adapter } of list) {
      if (adapter.id !== winner.id) continue;
      outEdges.push({
        sortKey: `${edge.source}|${edge.target}|${edge.kind}|${edge.meta?.type_only === true}`,
        edge: { ...edge, meta: { ...(edge.meta ?? {}), adapters } },
      });
    }
  }
  outEdges.sort(
    (a, b) =>
      cmpStr(a.sortKey, b.sortKey) ||
      cmpStr(a.edge.file ?? "", b.edge.file ?? "") ||
      (a.edge.line ?? 0) - (b.edge.line ?? 0),
  );

  return {
    nodes,
    edges: outEdges.map((e) => e.edge),
    coverage: {
      files_seen: filesSeen,
      parsed,
      unsupported: [...unsupported].sort(),
    },
    contributors,
  };
}
