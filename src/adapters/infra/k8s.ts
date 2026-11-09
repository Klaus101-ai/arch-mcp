// T4b: K8s-адаптер (ТЗ рев.3 §7, решения R19-R21).
// Кандидаты: .yaml/.yml с маркерами apiVersion/kind (sniff по тексту,
// CI-пути .github/workflows не берём — их обрабатывает ci-адаптер).
// Узлы service:<Kind>/<name> (R19), package:<image> образов контейнеров и
// ребро deploys workload→package (R20), config:<name> для envFrom/volumes
// с references-рёбрами (R20). Мультидокументный YAML через parseAllDocuments;
// битый → coverage.unsupported с причиной, без исключения. R21: module/imports
// не порождаются. Ноль файлов → absent.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseAllDocuments } from "yaml";
import { packageVersion } from "../../cache.ts";
import type { AdapterOutcome, DetailedAdapter } from "../../core/adapters/runner.ts";
import { listSourceFiles, sortDelta } from "../../core/adapters/tree-sitter/init.ts";
import type { Capability, GraphDelta, GraphEdge, GraphNode, ScanContext } from "../../core/adapters/types.ts";

export const K8S_ADAPTER_ID = "k8s";

const YAML_EXTS = new Set([".yaml", ".yml"]);

/** K8s-кандидат: есть маркеры apiVersion и kind; CI-workflows не берём. */
function isK8sManifest(rel: string, text: string): boolean {
  if (rel.startsWith(".github/workflows/")) return false;
  return text.includes("apiVersion:") && text.includes("kind:");
}

function collectCandidates(root: string): Array<{ rel: string; text: string }> {
  const out: Array<{ rel: string; text: string }> = [];
  for (const rel of listSourceFiles(root, YAML_EXTS)) {
    let text: string;
    try {
      text = readFileSync(join(root, rel), "utf8");
    } catch {
      continue; // нечитаемый — не кандидат
    }
    if (isK8sManifest(rel, text)) out.push({ rel, text });
  }
  return out;
}

type Json = Record<string, unknown>;

function isObj(v: unknown): v is Json {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Рекурсивный сбор строк по ключу (containers/initContainers → image и т.п.). */
function collectImages(node: unknown, out: Set<string>): void {
  if (Array.isArray(node)) {
    for (const item of node) collectImages(item, out);
    return;
  }
  if (!isObj(node)) return;
  for (const [key, value] of Object.entries(node)) {
    if ((key === "containers" || key === "initContainers") && Array.isArray(value)) {
      for (const c of value) if (isObj(c) && typeof c.image === "string" && c.image !== "") out.add(c.image);
    }
    collectImages(value, out);
  }
}

/** envFrom[].configMapRef/secretRef и volumes[].configMap/secret → имена конфигов. */
function collectConfigNames(node: unknown, out: Set<string>): void {
  if (Array.isArray(node)) {
    for (const item of node) collectConfigNames(item, out);
    return;
  }
  if (!isObj(node)) return;
  for (const [key, value] of Object.entries(node)) {
    if (key === "envFrom" && Array.isArray(value)) {
      for (const item of value) {
        if (!isObj(item)) continue;
        const ref = item.configMapRef ?? item.secretRef;
        if (isObj(ref) && typeof ref.name === "string" && ref.name !== "") out.add(ref.name);
      }
    }
    if (key === "volumes" && Array.isArray(value)) {
      for (const item of value) {
        if (!isObj(item)) continue;
        if (isObj(item.configMap) && typeof item.configMap.name === "string" && item.configMap.name !== "") {
          out.add(item.configMap.name);
        }
        if (isObj(item.secret) && typeof item.secret.secretName === "string" && item.secret.secretName !== "") {
          out.add(item.secret.secretName);
        }
      }
    }
    collectConfigNames(value, out);
  }
}

interface FileResult {
  nodes: GraphNode[];
  edges: GraphEdge[];
  ok: boolean;
  reason?: string;
}

function parseManifest(rel: string, text: string): FileResult {
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
  for (const doc of docs) {
    const js: unknown = doc.toJS();
    if (!isObj(js)) continue;
    const kind = js.kind;
    const metadata = js.metadata;
    if (typeof kind !== "string" || kind === "" || !isObj(metadata)) continue;
    const name = typeof metadata.name === "string" ? metadata.name : "";
    if (name === "") continue;
    const serviceId = `service:${kind}/${name}`;
    nodes.push({ id: serviceId, kind: "service", path: rel, name, source: K8S_ADAPTER_ID, meta: { k8s_kind: kind } });

    const images = new Set<string>();
    collectImages(js, images);
    for (const image of images) {
      const packageId = `package:${image}`;
      nodes.push({ id: packageId, kind: "package", path: rel, name: image, source: K8S_ADAPTER_ID });
      edges.push({
        source: serviceId,
        target: packageId,
        kind: "deploys",
        file: rel,
        confidence: "syntax",
        meta: { dependencyTypes: ["deploys"] },
      });
    }

    const configs = new Set<string>();
    collectConfigNames(js, configs);
    for (const cfg of configs) {
      const configId = `config:${cfg}`;
      nodes.push({ id: configId, kind: "config", path: rel, name: cfg, source: K8S_ADAPTER_ID });
      edges.push({
        source: serviceId,
        target: configId,
        kind: "references",
        file: rel,
        confidence: "syntax",
        meta: { dependencyTypes: ["references"] },
      });
    }
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
    const res = parseManifest(rel, text);
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

/** T4b: адаптер K8s-манифестов (ТЗ рев.3 §7, R19-R21). */
export const k8sAdapter: DetailedAdapter = {
  id: K8S_ADAPTER_ID,
  get version(): string {
    return packageVersion() ?? "0.0.0";
  },
  license: "ISC",
  precision: "syntax",
  priority: 50,
  detect(ctx: ScanContext): Promise<Capability[]> {
    const files = collectCandidates(ctx.root);
    return Promise.resolve(
      files.length > 0 ? [{ id: K8S_ADAPTER_ID, confidence: "syntax", detail: `${files.length} files` }] : [],
    );
  },
  async *scan(ctx: ScanContext): AsyncIterable<GraphDelta> {
    const run = await outcome(ctx);
    if (run.status === "ok") yield* run.deltas;
  },
  outcome,
};
