// T4b: CI-адаптер (ТЗ рев.3 §7, решения R19-R21).
// Кандидаты: .github/workflows/*.{yml,yaml} (repo-relative). Узел config:<file>
// (R19), рёбра references config→package:<action> по шагам uses: (R20,
// actions как пакеты, confidence syntax). Локальные uses ("./…") пакетом не
// считаются — ребро не создаётся. Битый YAML → coverage.unsupported с причиной,
// без исключения. R21: module/imports не порождаются. Ноль файлов → absent.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseAllDocuments } from "yaml";
import { packageVersion } from "../../cache.ts";
import type { AdapterOutcome, DetailedAdapter } from "../../core/adapters/runner.ts";
import { listSourceFiles, sortDelta } from "../../core/adapters/tree-sitter/init.ts";
import type { Capability, GraphDelta, GraphEdge, GraphNode, ScanContext } from "../../core/adapters/types.ts";

export const CI_ADAPTER_ID = "ci";

const YAML_EXTS = new Set([".yaml", ".yml"]);

function collectCandidates(root: string): Array<{ rel: string; text: string }> {
  const out: Array<{ rel: string; text: string }> = [];
  for (const rel of listSourceFiles(root, YAML_EXTS)) {
    if (!rel.startsWith(".github/workflows/")) continue;
    let text: string;
    try {
      text = readFileSync(join(root, rel), "utf8");
    } catch {
      continue; // нечитаемый — не кандидат
    }
    out.push({ rel, text });
  }
  return out;
}

type Json = Record<string, unknown>;

function isObj(v: unknown): v is Json {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Сбор значений "uses:" из дерева workflow (шаги, job-level, reusable workflows). */
function collectUses(node: unknown, out: Set<string>): void {
  if (Array.isArray(node)) {
    for (const item of node) collectUses(item, out);
    return;
  }
  if (!isObj(node)) return;
  for (const [key, value] of Object.entries(node)) {
    if (key === "uses" && typeof value === "string" && value !== "") out.add(value);
    else collectUses(value, out);
  }
}

/** uses-значение → package id: owner/repo (без @ref и ./); не-внешние — null. */
function actionPackageId(uses: string): string | null {
  if (uses.startsWith("./") || uses.startsWith("../") || uses.startsWith("/")) return null; // локальное действие
  const noRef = uses.split("@")[0];
  if (noRef === "") return null;
  if (noRef.includes("docker://")) return null;
  return `package:${noRef}`;
}

interface FileResult {
  nodes: GraphNode[];
  edges: GraphEdge[];
  ok: boolean;
  reason?: string;
}

function parseWorkflow(rel: string, text: string): FileResult {
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  let docs;
  try {
    docs = parseAllDocuments(text);
  } catch (err) {
    return { nodes, edges, ok: false, reason: err instanceof Error ? err.message.split("\n")[0] : String(err) };
  }
  if (docs.some((d) => d.errors.length > 0)) {
    const first = docs.find((d) => d.errors.length > 0);
    return { nodes, edges, ok: false, reason: first!.errors[0].message.split("\n")[0] };
  }
  const configId = `config:${rel}`;
  nodes.push({ id: configId, kind: "config", path: rel, name: rel.slice(rel.lastIndexOf("/") + 1), source: CI_ADAPTER_ID });

  const uses = new Set<string>();
  for (const doc of docs) collectUses(doc.toJS(), uses);
  for (const u of uses) {
    const packageId = actionPackageId(u);
    if (packageId === null) continue;
    nodes.push({
      id: packageId,
      kind: "package",
      path: rel,
      name: packageId.slice("package:".length),
      source: CI_ADAPTER_ID,
    });
    edges.push({
      source: configId,
      target: packageId,
      kind: "references",
      file: rel,
      confidence: "syntax",
      meta: { dependencyTypes: ["references"] },
    });
  }
  return { nodes, edges, ok: true };
}

function buildDelta(
  files: Array<{ rel: string; text: string }>,
): { delta: GraphDelta; reasons: Record<string, string> } {
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  const nodeIds = new Set<string>();
  const edgeKeys = new Set<string>();
  const unsupported: string[] = [];
  const reasons: Record<string, string> = {};
  for (const { rel, text } of files) {
    const res = parseWorkflow(rel, text);
    if (!res.ok) {
      unsupported.push(rel);
      reasons[rel] = res.reason ?? "yaml parse error";
      continue;
    }
    for (const n of res.nodes) {
      if (nodeIds.has(n.id)) continue;
      nodeIds.add(n.id);
      nodes.push(n);
    }
    for (const e of res.edges) {
      const key = `${e.kind}|${e.source}|${e.target}`;
      if (edgeKeys.has(key)) continue;
      edgeKeys.add(key);
      edges.push(e);
    }
  }
  const sorted = sortDelta(nodes, edges);
  return {
    delta: {
      nodes: sorted.nodes,
      edges: sorted.edges,
      coverage: { files_seen: files.length, parsed: files.length - unsupported.length, unsupported: [...unsupported].sort() },
    },
    reasons,
  };
}

async function outcome(ctx: ScanContext): Promise<AdapterOutcome> {
  const files = collectCandidates(ctx.root);
  if (files.length === 0) return { status: "absent", deltas: [] };
  const { delta, reasons } = buildDelta(files);
  const evidence = Object.keys(reasons).length > 0 ? { unsupported_reasons: reasons } : undefined;
  return { status: "ok", deltas: [delta], evidence };
}

/** T4b: адаптер CI-workflows (ТЗ рев.3 §7, R19-R21). */
export const ciAdapter: DetailedAdapter = {
  id: CI_ADAPTER_ID,
  get version(): string {
    return packageVersion() ?? "0.0.0";
  },
  license: "ISC",
  precision: "syntax",
  priority: 50,
  detect(ctx: ScanContext): Promise<Capability[]> {
    const files = collectCandidates(ctx.root);
    return Promise.resolve(
      files.length > 0 ? [{ id: CI_ADAPTER_ID, confidence: "syntax", detail: `${files.length} files` }] : [],
    );
  },
  async *scan(ctx: ScanContext): AsyncIterable<GraphDelta> {
    const run = await outcome(ctx);
    if (run.status === "ok") yield* run.deltas;
  },
  outcome,
};
