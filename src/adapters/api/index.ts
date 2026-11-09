// T4a: API-адаптер (ТЗ рев.3 §7, решения R14-R17).
// Пять форматов одним адаптером `api` (priority 50, precision syntax):
// OpenAPI 3.x (@readme/openapi-parser), Swagger 2.0/3.0 (@apidevtools/
// swagger-parser), .proto (protobufjs), GraphQL SDL (graphql), AsyncAPI
// (@asyncapi/parser). Узлы api/service и рёбра references — R14/R15;
// R16: module/imports не порождаются (legacy-счётчики не меняются);
// R17: без валидации по сети и без резолва внешних $ref — битые/внешние
// ссылки уходят в coverage.unsupported с причиной (evidence.unsupported_reasons),
// без исключения. Файлов нет → status "absent" (правило T2a).
import { readFileSync } from "node:fs";
import { extname, join } from "node:path";
import { packageVersion } from "../../cache.ts";
import type { AdapterOutcome, DetailedAdapter } from "../../core/adapters/runner.ts";
import { listSourceFiles, sortDelta } from "../../core/adapters/tree-sitter/init.ts";
import type { Capability, GraphDelta, GraphEdge, GraphNode, ScanContext } from "../../core/adapters/types.ts";
import { parseAsyncApiFile } from "./asyncapi.ts";
import { parseGraphQLFile } from "./graphql.ts";
import { parseOpenApiFile } from "./openapi.ts";
import { parseProtoFile } from "./proto.ts";
import { API_ADAPTER_ID, sniffDocMarker, type DocKind, type FileParseResult } from "./shared.ts";
import { parseSwaggerFile } from "./swagger.ts";

export { API_ADAPTER_ID } from "./shared.ts";

const DOC_EXTS = new Set([".yaml", ".yml", ".json"]);
const CODE_EXTS = new Set([".proto", ".graphql", ".gql"]);

interface Candidate {
  rel: string;
  kind: DocKind | "proto" | "graphql";
}

/**
 * Кандидаты на разбор: .proto/.graphql/.gql — по расширению; .yaml/.yml/.json —
 * только с маркером openapi/swagger/asyncapi в тексте (прочие конфиги не
 * учитываются в coverage вовсе). OpenAPI 3.0 → swagger.ts (поддержка 3.0),
 * 3.1+ → openapi.ts — разделение файлов ТЗ.
 */
function collectCandidates(root: string): Candidate[] {
  const out: Candidate[] = [];
  for (const rel of listSourceFiles(root, CODE_EXTS)) {
    const ext = extname(rel).toLowerCase();
    out.push({ rel, kind: ext === ".proto" ? "proto" : "graphql" });
  }
  for (const rel of listSourceFiles(root, DOC_EXTS)) {
    let text: string;
    try {
      text = readFileSync(join(root, rel), "utf8");
    } catch {
      continue; // нечитаемый файл — не кандидат (его нет в покрытии)
    }
    const marker = sniffDocMarker(text, extname(rel).toLowerCase());
    if (marker === null) continue;
    const kind: DocKind | "proto" | "graphql" =
      marker.kind === "openapi" && marker.version !== null && marker.version.startsWith("3.0")
        ? "swagger"
        : marker.kind;
    out.push({ rel, kind });
  }
  out.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
  return out;
}

async function parseCandidate(root: string, c: Candidate): Promise<FileParseResult> {
  const abs = join(root, c.rel);
  switch (c.kind) {
    case "openapi":
      return parseOpenApiFile(abs, c.rel);
    case "swagger":
      return parseSwaggerFile(abs, c.rel);
    case "asyncapi":
      return parseAsyncApiFile(abs, c.rel);
    case "proto":
      return parseProtoFile(abs, c.rel);
    case "graphql":
      return parseGraphQLFile(abs, c.rel);
  }
}

async function buildDelta(
  root: string,
  candidates: Candidate[],
): Promise<{ delta: GraphDelta; reasons: Record<string, string> }> {
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  const nodeIds = new Set<string>();
  const edgeKeys = new Set<string>();
  const unsupported: string[] = [];
  const reasons: Record<string, string> = {};

  for (const c of candidates) {
    const res = await parseCandidate(root, c);
    if (!res.ok) {
      unsupported.push(c.rel);
      reasons[c.rel] = res.reason;
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
  const delta: GraphDelta = {
    nodes: sorted.nodes,
    edges: sorted.edges,
    coverage: {
      files_seen: candidates.length,
      parsed: candidates.length - unsupported.length,
      unsupported: [...unsupported].sort(),
    },
  };
  return { delta, reasons };
}

async function outcome(ctx: ScanContext): Promise<AdapterOutcome> {
  const candidates = collectCandidates(ctx.root);
  if (candidates.length === 0) return { status: "absent", deltas: [] };
  const { delta, reasons } = await buildDelta(ctx.root, candidates);
  const evidence =
    Object.keys(reasons).length > 0
      ? { unsupported_reasons: reasons }
      : undefined;
  return { status: "ok", deltas: [delta], evidence };
}

/** T4a: адаптер API-описаний (ТЗ рев.3 §7). */
export const apiAdapter: DetailedAdapter = {
  id: API_ADAPTER_ID,
  get version(): string {
    return packageVersion() ?? "0.0.0";
  },
  license: "Apache-2.0 AND BSD-3-Clause AND MIT",
  precision: "syntax",
  priority: 50,
  detect(ctx: ScanContext): Promise<Capability[]> {
    const files = collectCandidates(ctx.root);
    return Promise.resolve(
      files.length > 0 ? [{ id: API_ADAPTER_ID, confidence: "syntax", detail: `${files.length} files` }] : [],
    );
  },
  async *scan(ctx: ScanContext): AsyncIterable<GraphDelta> {
    const run = await outcome(ctx);
    if (run.status === "ok") yield* run.deltas;
  },
  outcome,
};
