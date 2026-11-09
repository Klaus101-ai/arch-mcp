import { normalizeNode } from "../paths.ts";
import { applyResponseBudget, DEFAULT_MAX_BYTES } from "../tools/queries.ts";
import type { GraphEdge } from "../tools/get_graph.ts";
import type { SnapshotSide, StoredSnapshot } from "./snapshots.ts";

/**
 * arch_diff (ТЗ рев.3, п.7): сравнение двух снимков —
 * добавленные/удалённые узлы и рёбра между snapshot_id/HEAD/current.
 */

const HINT_DIFF = "truncated by ARCH_MCP_MAX_RESPONSE_BYTES — raise max_bytes to see the full diff";

export interface DiffEdge {
  source: string;
  target: string;
  type: string;
  type_only: boolean;
}

export interface DiffPayload {
  repo: string;
  from: SnapshotSide;
  to: SnapshotSide;
  added_nodes: string[];
  removed_nodes: string[];
  added_edges: DiffEdge[];
  removed_edges: DiffEdge[];
  counts: { added_nodes: number; removed_nodes: number; added_edges: number; removed_edges: number };
  truncated: boolean;
  hint?: string;
}

function edgeKey(e: GraphEdge): string {
  return `${e.source}\u0000${e.target}\u0000${e.type}\u0000${e.meta?.type_only === true}`;
}

function toDiffEdge(e: GraphEdge, repo: string): DiffEdge {
  return {
    source: normalizeNode(e.source, repo),
    target: normalizeNode(e.target, repo),
    type: e.type,
    type_only: e.meta?.type_only === true,
  };
}

function byName(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Разница from → to: множества узлов и рёбер (ключ ребра учитывает type_only). */
export function diffSnapshots(
  from: StoredSnapshot,
  to: StoredSnapshot,
  repo: string,
  opts: { maxBytes?: number; fromSide?: SnapshotSide; toSide?: SnapshotSide } = {},
): DiffPayload {
  const fromNodes = new Set(from.graph.nodes);
  const toNodes = new Set(to.graph.nodes);
  const addedNodes = [...toNodes].filter((n) => !fromNodes.has(n)).map((n) => normalizeNode(n, repo)).sort(byName);
  const removedNodes = [...fromNodes].filter((n) => !toNodes.has(n)).map((n) => normalizeNode(n, repo)).sort(byName);

  const fromEdges = new Map(from.graph.edges.map((e) => [edgeKey(e), e]));
  const toEdges = new Map(to.graph.edges.map((e) => [edgeKey(e), e]));
  const addedEdges = [...toEdges.entries()]
    .filter(([k]) => !fromEdges.has(k))
    .map(([, e]) => toDiffEdge(e, repo))
    .sort((a, b) => byName(a.source, b.source) || byName(a.target, b.target) || byName(a.type, b.type));
  const removedEdges = [...fromEdges.entries()]
    .filter(([k]) => !toEdges.has(k))
    .map(([, e]) => toDiffEdge(e, repo))
    .sort((a, b) => byName(a.source, b.source) || byName(a.target, b.target) || byName(a.type, b.type));

  const payload = {
    repo,
    from: opts.fromSide ?? sideOf(from),
    to: opts.toSide ?? sideOf(to),
    added_nodes: addedNodes,
    removed_nodes: removedNodes,
    added_edges: addedEdges,
    removed_edges: removedEdges,
    counts: {
      added_nodes: addedNodes.length,
      removed_nodes: removedNodes.length,
      added_edges: addedEdges.length,
      removed_edges: removedEdges.length,
    },
  };
  return applyResponseBudget(
    payload,
    opts.maxBytes ?? DEFAULT_MAX_BYTES,
    ["added_nodes", "removed_nodes", "added_edges", "removed_edges"],
    HINT_DIFF,
  );
}

function sideOf(snap: StoredSnapshot): SnapshotSide {
  return { ref: snap.snapshot_id, snapshot_id: snap.snapshot_id, git_head: snap.git_head, ts: snap.ts };
}
