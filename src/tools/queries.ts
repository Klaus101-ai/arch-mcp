import { isTestFile, matchNode, normalizeNode } from "../paths.ts";
import { ArchMcpError } from "../core/errors.ts";
import type { NormalizedGraph } from "./get_graph.ts";

/**
 * Query-инструменты над ПОЛНЫМ raw-графом (бюджет на графе не применяется):
 * focus — связи узла, reaches — обратная достижимость, impact — затронутые
 * изменением, affected_tests — транзитивно использующие изменённое тестовые
 * файлы, search — поиск узлов. ARCH_MCP_MAX_RESPONSE_BYTES применяется
 * только к ответу (applyResponseBudget).
 * include_type_only (дефолт false): рёбра depcruiser с dependencyTypes
 * "type-only" (meta.type_only) исключаются из обхода.
 */

export const DEFAULT_FOCUS_LIMIT = 50;
export const MAX_FOCUS_LIMIT = 200;
export const DEFAULT_MAX_DEPTH = 10;
/** Дефолт ARCH_MCP_MAX_RESPONSE_BYTES (config.ts) — для вызовов без cfg. */
export const DEFAULT_MAX_BYTES = 65_536;

const HINT_FOCUS = "truncated by ARCH_MCP_MAX_RESPONSE_BYTES — use focus(repo, node) to inspect a single node";
const HINT_LIMIT = "truncated by ARCH_MCP_MAX_RESPONSE_BYTES — lower the limit (max 200)";
const HINT_SEARCH = "truncated by ARCH_MCP_MAX_RESPONSE_BYTES — narrow the query or raise max_bytes";

/**
 * Бюджет ответа: если JSON не влезает — усекаются списки (пропорционально),
 * ставится truncated и подсказка. Внутри бюджета payload не меняется.
 */
export function applyResponseBudget<T extends Record<string, unknown>>(
  payload: T,
  maxBytes: number,
  arrayKeys: readonly string[],
  hint: string,
  truncatedByLimit = false,
): T & { truncated: boolean; hint?: string } {
  const fits = (p: unknown): boolean => Buffer.byteLength(JSON.stringify(p), "utf8") <= maxBytes;
  const base = {
    ...payload,
    truncated: truncatedByLimit,
    ...(truncatedByLimit ? { hint } : {}),
  } as T & { truncated: boolean; hint?: string };
  if (fits(base)) return base;

  let lo = 0;
  let hi = 1;
  let best = 0;
  for (let i = 0; i < 24 && hi - lo > 1e-9; i++) {
    const mid = (lo + hi) / 2;
    const cand: Record<string, unknown> = { ...payload, truncated: true, hint };
    for (const key of arrayKeys) {
      const arr = payload[key];
      if (Array.isArray(arr)) cand[key] = arr.slice(0, Math.floor(arr.length * mid));
    }
    if (fits(cand)) {
      best = mid;
      lo = mid;
    } else {
      hi = mid;
    }
  }
  const out: Record<string, unknown> = { ...payload, truncated: true, hint };
  for (const key of arrayKeys) {
    const arr = payload[key];
    if (Array.isArray(arr)) out[key] = arr.slice(0, Math.floor(arr.length * best));
  }
  return out as T & { truncated: boolean; hint?: string };
}

function matchOrThrow(input: string, repo: string, nodes: readonly string[]): { node: string; path: string } {
  const match = matchNode(input, repo, nodes);
  if (match.status === "ambiguous") {
    throw new ArchMcpError("AMBIGUOUS_NODE", `ambiguous path "${input}": matches ${match.matches.join(", ")}`, {
      candidates: match.matches,
      hint: "pass a more specific path (repo-relative POSIX)",
    });
  }
  if (match.status === "invalid") {
    throw new ArchMcpError("NODE_NOT_FOUND", match.reason, { hint: "use search() to find the node path" });
  }
  return { node: match.node, path: match.path };
}

function byName(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function normalizeLimit(raw: unknown): number {
  if (raw === undefined || raw === null) return DEFAULT_FOCUS_LIMIT;
  const n = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(n)) {
    throw new ArchMcpError("INVALID_ARGUMENT", `limit must be a finite number, got: ${JSON.stringify(raw)}`, {
      hint: `limit: integer 1..${MAX_FOCUS_LIMIT}`,
    });
  }
  return Math.min(MAX_FOCUS_LIMIT, Math.max(1, Math.floor(n)));
}

/** Граф без type-only рёбер (include_type_only=false — дефолт). */
export function filterTypeOnly(graph: NormalizedGraph, includeTypeOnly?: boolean): NormalizedGraph {
  if (includeTypeOnly === true) return graph;
  const edges = graph.edges.filter((e) => e.meta?.type_only !== true);
  return edges.length === graph.edges.length ? graph : { nodes: graph.nodes, edges };
}

export interface FocusPayload {
  repo: string;
  /** repo-relative путь запрошенного узла. */
  node: string;
  /**
   * Дельта рев.8: у элементов с lineage-колонками (sqlglot-рёбра) есть
   * необязательное columns — копия meta.columns ребра; у рёбер без колонок
   * поля нет. Сортировка/limit/counts/бюджет не меняются.
   */
  incoming: Array<{ source: string; type: string; columns?: Array<{ from: string; to: string }> }>;
  outgoing: Array<{ target: string; type: string; columns?: Array<{ from: string; to: string }> }>;
  /** Размеры списков до обрезки по limit/бюджету. */
  counts: { incoming: number; outgoing: number };
  limit: number;
  include_type_only: boolean;
  truncated: boolean;
  hint?: string;
}

/** Копия lineage-columns ребра, если они есть; иначе undefined (поля нет). */
function edgeColumns(meta: { columns?: Array<{ from: string; to: string }> } | undefined): Array<{ from: string; to: string }> | undefined {
  const cols = meta?.columns;
  return Array.isArray(cols) && cols.length > 0 ? cols.map((c) => ({ ...c })) : undefined;
}

/** focus(repo, node): входящие и исходящие связи узла с типами. */
export function focus(
  graph: NormalizedGraph,
  repo: string,
  node: string,
  opts: { limit?: number; maxBytes?: number; include_type_only?: boolean } = {},
): FocusPayload {
  const g = filterTypeOnly(graph, opts.include_type_only);
  const { node: id, path } = matchOrThrow(node, repo, g.nodes);
  const limit = normalizeLimit(opts.limit);
  const includeTypeOnly = opts.include_type_only === true;
  const incoming = g.edges
    .filter((e) => e.target === id)
    .map((e) => {
      const item: { source: string; type: string; columns?: Array<{ from: string; to: string }> } = {
        source: normalizeNode(e.source, repo),
        type: e.type,
      };
      const cols = edgeColumns(e.meta);
      if (cols) item.columns = cols;
      return item;
    })
    .sort((a, b) => byName(a.source, b.source) || byName(a.type, b.type));
  const outgoing = g.edges
    .filter((e) => e.source === id)
    .map((e) => {
      const item: { target: string; type: string; columns?: Array<{ from: string; to: string }> } = {
        target: normalizeNode(e.target, repo),
        type: e.type,
      };
      const cols = edgeColumns(e.meta);
      if (cols) item.columns = cols;
      return item;
    })
    .sort((a, b) => byName(a.target, b.target) || byName(a.type, b.type));
  const truncatedByLimit = incoming.length > limit || outgoing.length > limit;
  const payload = {
    repo,
    node: path,
    incoming: incoming.slice(0, limit),
    outgoing: outgoing.slice(0, limit),
    counts: { incoming: incoming.length, outgoing: outgoing.length },
    limit,
    include_type_only: includeTypeOnly,
  };
  return applyResponseBudget(payload, opts.maxBytes ?? DEFAULT_MAX_BYTES, ["incoming", "outgoing"], HINT_LIMIT, truncatedByLimit);
}

export interface ReachPayload {
  repo: string;
  node: string;
  maxDepth: number;
  include_type_only: boolean;
  /** Кто зависит от цели: [{node, distance}], сортировка по расстоянию. */
  results: Array<{ node: string; distance: number }>;
  truncated: boolean;
  hint?: string;
}

/** Обратный BFS по входящим рёбрам: dist=1 — прямые зависимые от целей. */
function reverseDistances(graph: NormalizedGraph, targets: readonly string[], maxDepth: number | null): Map<string, number> {
  const inc = new Map<string, string[]>();
  for (const e of graph.edges) {
    const list = inc.get(e.target);
    if (list) list.push(e.source);
    else inc.set(e.target, [e.source]);
  }
  const dist = new Map<string, number>();
  let frontier: string[] = [];
  for (const t of targets) {
    dist.set(t, 0);
    frontier.push(t);
  }
  for (let d = 1; frontier.length > 0 && (maxDepth === null || d <= maxDepth); d++) {
    const next: string[] = [];
    for (const n of frontier) {
      for (const src of inc.get(n) ?? []) {
        if (!dist.has(src)) {
          dist.set(src, d);
          next.push(src);
        }
      }
    }
    frontier = next;
  }
  return dist;
}

function normalizeDepth(raw: unknown, field: "maxDepth" | "depth"): number {
  if (raw === undefined || raw === null) return DEFAULT_MAX_DEPTH;
  if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 1) {
    throw new ArchMcpError(
      "INVALID_ARGUMENT",
      `${field} must be a positive integer (whole edges), got: ${JSON.stringify(raw)}`,
      { hint: `${field}: integer >= 1` },
    );
  }
  return raw;
}

/** reaches(repo, target, max_depth?): обратная достижимость — кто зависит от цели. */
export function reaches(
  graph: NormalizedGraph,
  repo: string,
  target: string,
  opts: { maxDepth?: number; maxBytes?: number; include_type_only?: boolean } = {},
): ReachPayload {
  const maxDepth = normalizeDepth(opts.maxDepth, "maxDepth");
  const g = filterTypeOnly(graph, opts.include_type_only);
  const { node: id, path } = matchOrThrow(target, repo, g.nodes);
  const dist = reverseDistances(g, [id], maxDepth);
  const results = [...dist.entries()]
    .filter(([nid]) => nid !== id)
    .map(([nid, distance]) => ({ node: normalizeNode(nid, repo), distance }))
    .sort((a, b) => a.distance - b.distance || byName(a.node, b.node));
  const payload = { repo, node: path, maxDepth, include_type_only: opts.include_type_only === true, results };
  return applyResponseBudget(payload, opts.maxBytes ?? DEFAULT_MAX_BYTES, ["results"], HINT_FOCUS);
}

export interface AffectedTestsPayload {
  repo: string;
  /** Проверенные входы: разрешённые repo-relative пути changed[]. */
  changed: string[];
  /** Транзитивно использующие изменённое тестовые файлы (repo-relative). */
  tests: string[];
  include_type_only: boolean;
  /** Причина пустого результата (только когда tests пуст). */
  reason?: string;
  truncated: boolean;
  hint?: string;
}

function normalizeChanged(changed: unknown): string[] {
  if (!Array.isArray(changed) || changed.length === 0 || changed.some((c) => typeof c !== "string")) {
    throw new ArchMcpError("INVALID_ARGUMENT", "changed must be a non-empty array of path strings", {
      hint: 'changed: ["path/inside/workspace"]',
    });
  }
  return changed as string[];
}

/** affected_tests(repo, changed[]): тестовые файлы, транзитивно использующие изменённые. */
export function affectedTests(
  graph: NormalizedGraph,
  repo: string,
  changed: readonly string[],
  opts: { maxBytes?: number; include_type_only?: boolean } = {},
): AffectedTestsPayload {
  normalizeChanged(changed);
  const g = filterTypeOnly(graph, opts.include_type_only);
  const targets: string[] = [];
  const resolved: string[] = [];
  for (const input of changed) {
    const { node: id, path } = matchOrThrow(String(input), repo, g.nodes);
    if (!targets.includes(id)) targets.push(id);
    if (!resolved.includes(path)) resolved.push(path);
  }
  const dist = reverseDistances(g, targets, null);
  const tests = [
    ...new Set(
      [...dist.entries()]
        .filter(([id, d]) => d > 0 && isTestFile(normalizeNode(id, repo)))
        .map(([id]) => normalizeNode(id, repo)),
    ),
  ].sort(byName);
  const payload: Omit<AffectedTestsPayload, "truncated" | "hint"> = {
    repo,
    changed: resolved,
    tests,
    include_type_only: opts.include_type_only === true,
  };
  if (tests.length === 0) {
    payload.reason = `no test file depends on the changed inputs (checked: ${resolved.join(", ")})`;
  }
  return applyResponseBudget(payload, opts.maxBytes ?? DEFAULT_MAX_BYTES, ["tests", "changed"], HINT_FOCUS);
}

export interface ImpactPayload {
  repo: string;
  /** Разрешённые repo-relative пути changed[]. */
  changed: string[];
  depth: number;
  include_type_only: boolean;
  /** Затронутые изменением (кроме самих changed[]): [{node, distance}]. */
  results: Array<{ node: string; distance: number }>;
  truncated: boolean;
  hint?: string;
}

/**
 * impact(repo, changed[], depth?): обратная достижимость изменённых —
 * что затронет правка (транзитивные зависимые, эпицентр исключён).
 */
export function impact(
  graph: NormalizedGraph,
  repo: string,
  changed: readonly string[],
  opts: { depth?: number; maxBytes?: number; include_type_only?: boolean } = {},
): ImpactPayload {
  normalizeChanged(changed);
  const depth = normalizeDepth(opts.depth, "depth");
  const g = filterTypeOnly(graph, opts.include_type_only);
  const targets: string[] = [];
  const resolved: string[] = [];
  for (const input of changed) {
    const { node: id, path } = matchOrThrow(String(input), repo, g.nodes);
    if (!targets.includes(id)) targets.push(id);
    if (!resolved.includes(path)) resolved.push(path);
  }
  const dist = reverseDistances(g, targets, depth);
  const results = [...dist.entries()]
    .filter(([nid, d]) => d > 0)
    .map(([nid, distance]) => ({ node: normalizeNode(nid, repo), distance }))
    .sort((a, b) => a.distance - b.distance || byName(a.node, b.node));
  const payload = {
    repo,
    changed: resolved,
    depth,
    include_type_only: opts.include_type_only === true,
    results,
  };
  return applyResponseBudget(payload, opts.maxBytes ?? DEFAULT_MAX_BYTES, ["results"], HINT_FOCUS);
}

/** Виды узлов графа с ведущим префиксом `<kind>:` в id (ТЗ рев.3, п.1). */
const NODE_VIEW_KINDS = [
  "module",
  "package",
  "symbol",
  "table",
  "view",
  "api",
  "config",
  "doc",
  "service",
  "container",
] as const;

export type SearchKind = "file" | "dir" | "test" | "all" | (typeof NODE_VIEW_KINDS)[number];
export const SEARCH_KINDS: readonly SearchKind[] = ["file", "dir", "test", "all", ...NODE_VIEW_KINDS];

export interface SearchMatch {
  node: string;
  kind: SearchKind;
}

export interface SearchPayload {
  repo: string;
  query: string;
  kind: SearchKind;
  matches: SearchMatch[];
  /** Размер matches до обрезки по бюджету. */
  count: number;
  truncated: boolean;
  hint?: string;
}

/** Релевантность: точный путь → базовое имя → суффикс → подстрока. */
function scorePath(candidate: string, query: string): number {
  const lp = candidate.toLowerCase();
  const lq = query.toLowerCase();
  if (lp === lq) return 0;
  const base = lp.slice(lp.lastIndexOf("/") + 1);
  if (base === lq) return 1;
  if (lp.endsWith("/" + lq)) return 2;
  if (lp.includes(lq)) return 3;
  return -1;
}

function normalizeKind(raw: unknown): SearchKind {
  if (raw === undefined || raw === null) return "file";
  if (typeof raw !== "string" || !(SEARCH_KINDS as readonly string[]).includes(raw)) {
    throw new ArchMcpError(
      "INVALID_ARGUMENT",
      `kind must be one of ${SEARCH_KINDS.join("|")}, got: ${JSON.stringify(raw)}`,
      {
        hint: `kind: ${SEARCH_KINDS.join(" | ")}`,
      },
    );
  }
  return raw as SearchKind;
}

/** Вид узла по ведущему префиксу `<kind>:` (известный вид), иначе null — это файл. */
function nodeViewKind(node: string): SearchKind | null {
  const i = node.indexOf(":");
  if (i <= 0) return null;
  const head = node.slice(0, i);
  return (NODE_VIEW_KINDS as readonly string[]).includes(head) ? (head as SearchKind) : null;
}

/**
 * search(repo, query, kind?): поиск узлов графа по подстроке (регистронезависимо).
 * kind: file (дефолт — только файлы, у тестов kind="test"), test — только тестовые,
 * dir — синтетические каталоги, all — все реальные узлы с настоящим видом
 * (без каталогов), module|package|symbol|table|view|api|config|doc|service|container —
 * только узлы этого вида по ведущему префиксу `<kind>:` в id. Нет совпадений → count 0.
 */
export function search(
  graph: NormalizedGraph,
  repo: string,
  query: unknown,
  opts: { kind?: unknown; maxBytes?: number } = {},
): SearchPayload {
  if (typeof query !== "string" || query.trim() === "") {
    throw new ArchMcpError("INVALID_ARGUMENT", "query must be a non-empty string", { hint: "query: substring to search" });
  }
  const q = query.trim();
  const kind = normalizeKind(opts.kind);

  const candidates: SearchMatch[] = [];
  if (kind === "dir") {
    const dirs = new Set<string>();
    for (const node of graph.nodes) {
      const norm = normalizeNode(node, repo);
      const i = norm.lastIndexOf("/");
      if (i > 0) dirs.add(norm.slice(0, i));
    }
    for (const d of [...dirs].sort()) candidates.push({ node: d, kind: "dir" });
  } else {
    const seen = new Set<string>();
    for (const node of graph.nodes) {
      const norm = normalizeNode(node, repo);
      const view = nodeViewKind(norm);
      if (kind === "all") {
        if (seen.has(norm)) continue;
        seen.add(norm);
        candidates.push({ node: norm, kind: view ?? (isTestFile(norm) ? "test" : "file") });
        continue;
      }
      if (view !== null) {
        // Узел с ведущим префиксом вида: только в свой kind (и в all — выше).
        if (kind === view && !seen.has(norm)) {
          seen.add(norm);
          candidates.push({ node: norm, kind: view });
        }
        continue;
      }
      if (kind === "test" && !isTestFile(norm)) continue;
      const base = norm.slice(norm.lastIndexOf("/") + 1);
      if (!/\.[^./]+$/.test(base)) continue; // листья-файлы (без расширения — не файл)
      if (seen.has(norm)) continue;
      seen.add(norm);
      candidates.push({ node: norm, kind: isTestFile(norm) ? "test" : "file" });
    }
  }

  const scored: Array<{ m: SearchMatch; s: number }> = [];
  for (const m of candidates) {
    const s = scorePath(m.node, q);
    if (s >= 0) scored.push({ m, s });
  }
  scored.sort((a, b) => a.s - b.s || byName(a.m.node, b.m.node));
  const matches = scored.map((x) => x.m);
  const payload = { repo, query: q, kind, matches, count: matches.length };
  return applyResponseBudget(payload, opts.maxBytes ?? DEFAULT_MAX_BYTES, ["matches"], HINT_SEARCH);
}
