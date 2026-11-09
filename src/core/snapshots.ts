import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { sha1Hex, GRAPH_SCHEMA_VERSION, packageVersion } from "../cache.ts";
import { listAdapters } from "./adapters/registry.ts";
import { ArchMcpError } from "./errors.ts";
import type { NormalizedGraph } from "../tools/get_graph.ts";

/**
 * Снимки графа в кэше (ТЗ рев.3, п.7):
 * snapshot_id = SHA256(JSON графа + git HEAD + версии адаптеров);
 * хранение в <cacheRoot>/snapshots/<sha1(workspace)>/; маппинг HEAD → id.
 * Произвольные git-ревизии не читаются — v1.1.
 */

export interface StoredSnapshot {
  snapshot_id: string;
  workspace: string;
  git_head: string | null;
  ts: string;
  graph: NormalizedGraph;
  adapters: Record<string, string | null>;
}

export interface SnapshotSide {
  ref: string;
  snapshot_id: string;
  git_head: string | null;
  ts: string;
}

function canonicalGraph(graph: NormalizedGraph): NormalizedGraph {
  const nodes = [...graph.nodes].sort();
  const edges = [...graph.edges]
    .map((e) => ({
      source: e.source,
      target: e.target,
      type: e.type,
      meta: { type_only: e.meta?.type_only === true },
    }))
    .sort((a, b) => {
      const ka = `${a.source}\u0000${a.target}\u0000${a.type}\u0000${a.meta.type_only}`;
      const kb = `${b.source}\u0000${b.target}\u0000${b.type}\u0000${b.meta.type_only}`;
      return ka < kb ? -1 : ka > kb ? 1 : 0;
    });
  return { nodes, edges };
}

/** snapshot_id = SHA256(JSON канонического графа + git HEAD + версии адаптеров). */
export function snapshotId(input: {
  graph: NormalizedGraph;
  gitHead: string | null;
  adapters: Record<string, string | null>;
}): string {
  const adapters = Object.fromEntries(
    Object.entries(input.adapters)
      .map(([k, v]) => [k, v ?? null] as const)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
  );
  const canonical = JSON.stringify({
    graph: canonicalGraph(input.graph),
    git_head: input.gitHead ?? null,
    adapters,
  });
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

export function snapshotsDir(cacheRootDir: string, workspace: string): string {
  return join(cacheRootDir, "snapshots", sha1Hex(workspace.replace(/\\/g, "/").toLowerCase()));
}

/**
 * T1.2b: версии адаптеров из реестра + package/schema — вход snapshot_id
 * (вместо хардкода depcruiser в server_core). Смена состава/версии адаптера
 * меняет id снимка так же, как и ключ кэша (R4).
 */
export function adapterVersions(): Record<string, string | null> {
  const out: Record<string, string | null> = {};
  for (const adapter of listAdapters()) out[adapter.id] = adapter.version;
  out.package = packageVersion();
  out.schema = GRAPH_SCHEMA_VERSION;
  return out;
}

function atomicWrite(file: string, text: string): void {
  mkdirSync(join(file, ".."), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, text, "utf8");
  renameSync(tmp, file);
}

function readHeads(dir: string): Record<string, string> {
  const file = join(dir, "heads.json");
  if (!existsSync(file)) return {};
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      return parsed as Record<string, string>;
    }
    return {};
  } catch {
    return {};
  }
}

/** Запись снимка: <id>.json + маппинг HEAD → id (последний выигрывает). */
export function saveSnapshot(cacheRootDir: string, snap: StoredSnapshot): void {
  const dir = snapshotsDir(cacheRootDir, snap.workspace);
  mkdirSync(dir, { recursive: true });
  atomicWrite(join(dir, `${snap.snapshot_id}.json`), JSON.stringify(snap));
  if (typeof snap.git_head === "string" && snap.git_head !== "") {
    const heads = readHeads(dir);
    heads[snap.git_head] = snap.snapshot_id;
    atomicWrite(join(dir, "heads.json"), JSON.stringify(heads));
  }
}

export function loadSnapshotById(cacheRootDir: string, workspace: string, id: string): StoredSnapshot | null {
  const file = join(snapshotsDir(cacheRootDir, workspace), `${id}.json`);
  if (!existsSync(file)) return null;
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as StoredSnapshot;
    return parsed && parsed.snapshot_id === id ? parsed : null;
  } catch {
    return null;
  }
}

export function loadSnapshotByHead(cacheRootDir: string, workspace: string, head: string): StoredSnapshot | null {
  const id = readHeads(snapshotsDir(cacheRootDir, workspace))[head];
  if (typeof id !== "string") return null;
  return loadSnapshotById(cacheRootDir, workspace, id);
}

/**
 * Разрешение git-HEAD-ссылки по heads.json: полный HEAD (точное совпадение)
 * либо уникальный префикс 7..39 hex → полный HEAD. Неоднозначный префикс →
 * AMBIGUOUS_NODE с кандидатами (полные HEAD); совпадений нет → null
 * (вызывающая сторона бросает SNAPSHOT_NOT_FOUND).
 */
function loadSnapshotByHeadPrefix(cacheRootDir: string, workspace: string, prefix: string): StoredSnapshot | null {
  const heads = readHeads(snapshotsDir(cacheRootDir, workspace));
  const p = prefix.toLowerCase();
  const exact = heads[p];
  if (typeof exact === "string") return loadSnapshotById(cacheRootDir, workspace, exact);
  const matches = Object.keys(heads)
    .filter((h) => h.toLowerCase().startsWith(p))
    .sort();
  if (matches.length === 1) return loadSnapshotById(cacheRootDir, workspace, heads[matches[0]]);
  if (matches.length > 1) {
    throw new ArchMcpError("AMBIGUOUS_NODE", `ambiguous git HEAD prefix: ${prefix}`, {
      hint: `prefix matches ${matches.length} HEADs — pass a longer prefix (up to 40 hex) or a snapshot_id`,
      candidates: matches,
    });
  }
  return null;
}

export interface RefContext {
  cacheRoot: string;
  workspace: string;
  /** Построить снимок «сейчас» для ref=current. */
  buildCurrent: () => Promise<StoredSnapshot>;
}

const HEX_REF = /^[0-9a-f]{7,64}$/i;
const SNAPSHOT_ID_REF = /^[0-9a-f]{64}$/i;

/**
 * Разрешение ссылки arch_diff:
 * "current" → свежий снимок; 64-hex → по snapshot_id; 7..63 hex → по git HEAD
 * (полный HEAD или уникальный префикс 7..39 hex; неоднозначность →
 * AMBIGUOUS_NODE с кандидатами); неверный формат → INVALID_ARGUMENT;
 * снимок не найден → SNAPSHOT_NOT_FOUND.
 * Произвольные git-ревизии (HEAD~1, ветки) — v1.1.
 */
export async function resolveSnapshotRef(ref: unknown, ctx: RefContext): Promise<{ side: SnapshotSide; snapshot: StoredSnapshot }> {
  if (typeof ref !== "string" || ref.trim() === "") {
    throw new ArchMcpError("INVALID_ARGUMENT", `ref must be a non-empty string, got: ${JSON.stringify(ref)}`, {
      hint: 'ref: "current" | git HEAD (7-64 hex, unique 7..39 prefix ok) | snapshot_id (64 hex); arbitrary git revisions — v1.1',
    });
  }
  const value = ref.trim();
  if (value.toLowerCase() === "current") {
    const snapshot = await ctx.buildCurrent();
    return { side: { ref: "current", snapshot_id: snapshot.snapshot_id, git_head: snapshot.git_head, ts: snapshot.ts }, snapshot };
  }
  if (!HEX_REF.test(value)) {
    throw new ArchMcpError("INVALID_ARGUMENT", `unsupported ref format: ${value}`, {
      hint: 'ref: "current" | git HEAD (7-64 hex, unique 7..39 prefix ok) | snapshot_id (64 hex); arbitrary git revisions — v1.1',
    });
  }
  const snapshot = SNAPSHOT_ID_REF.test(value)
    ? loadSnapshotById(ctx.cacheRoot, ctx.workspace, value.toLowerCase())
    : loadSnapshotByHeadPrefix(ctx.cacheRoot, ctx.workspace, value);
  if (snapshot === null) {
    throw new ArchMcpError("SNAPSHOT_NOT_FOUND", `no snapshot for ref: ${value}`, {
      hint: "call arch_snapshot first to store a snapshot for this workspace/HEAD; git HEAD refs accept a unique 7..39 hex prefix; arbitrary git revisions — v1.1",
    });
  }
  return { side: { ref: value, snapshot_id: snapshot.snapshot_id, git_head: snapshot.git_head, ts: snapshot.ts }, snapshot };
}
