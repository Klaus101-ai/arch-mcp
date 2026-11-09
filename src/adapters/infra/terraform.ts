// T4b: Terraform-адаптер (ТЗ рев.3 §7, решения R19, R20, R22).
// R22: работает только при ARCH_MCP_TERRAFORM=1; без флага адаптер absent
// (не missing, не ошибка) — MPL-модуль @cdktf/hcl2json опционален. Импорт
// ленивый (dynamic import только при включённом флаге), чтобы MPL-код не
// попадал в основной бандл; CLI Terraform не вызывается (BUSL).
// Узлы service:<type>.<name> ресурсов (R19), рёбра references по ${...}-
// интерполяции между ресурсами (R20, confidence syntax). Битый HCL →
// coverage.unsupported с причиной, без исключения. R21: module/imports нет.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { packageVersion } from "../../cache.ts";
import type { AdapterOutcome, DetailedAdapter } from "../../core/adapters/runner.ts";
import { listSourceFiles, sortDelta } from "../../core/adapters/tree-sitter/init.ts";
import type { Capability, GraphDelta, GraphEdge, GraphNode, ScanContext } from "../../core/adapters/types.ts";

export const TERRAFORM_ADAPTER_ID = "terraform";

const TF_EXTS = new Set([".tf"]);

function terraformEnabled(): boolean {
  return process.env.ARCH_MCP_TERRAFORM === "1";
}

function collectCandidates(root: string): string[] {
  return listSourceFiles(root, TF_EXTS);
}

type Json = Record<string, unknown>;

function isObj(v: unknown): v is Json {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Все строки в значении (рекурсивно) — для поиска ${...}-интерполяций. */
function collectStrings(node: unknown, out: string[]): void {
  if (typeof node === "string") {
    out.push(node);
    return;
  }
  if (Array.isArray(node)) {
    for (const item of node) collectStrings(item, out);
    return;
  }
  if (isObj(node)) {
    for (const value of Object.values(node)) collectStrings(value, out);
  }
}

/** Ссылки из строки: ${type.name...} → ["type.name"] (только ресурсные пути). */
function resourceRefs(text: string): string[] {
  const out: string[] = [];
  const re = /\$\{\s*([A-Za-z0-9_\-]+)\.([A-Za-z0-9_\-]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) out.push(`${m[1]}.${m[2]}`);
  return out;
}

interface FileResult {
  nodes: GraphNode[];
  edges: GraphEdge[];
  ok: boolean;
  reason?: string;
}

/**
 * .tf → service-узлы ресурсов. Рёбра references строятся позже (межфайловые
 * ссылки): здесь возвращаются узлы + список {source, refs} по файлам.
 */
function parseTfFile(rel: string, text: string): Promise<{
  nodes: GraphNode[];
  refs: Array<{ source: string; refs: string[] }>;
  ok: boolean;
  reason?: string;
}> {
  const nodes: GraphNode[] = [];
  const refs: Array<{ source: string; refs: string[] }> = [];
  // Ленивый MPL-импорт — только при активном флаге (вне outcome не вызывается).
  return import("@cdktf/hcl2json")
    .then((hcl) => hcl.parse(rel, text))
    .then((json: unknown) => {
      if (!isObj(json)) return { nodes, refs, ok: false, reason: "hcl2json: unexpected output" };
      // T5, фикс [MINOR] 6325: hcl2json парсит `resource "тип" { ... }` без второй
      // метки в массив ({resource:{тип:[...]}}) и не бросает ошибку — раньше такой
      // файл молча давал parsed=1, nodes=0. Массив/не-объект вместо карты имён и
      // не-объект под ключом resource — признак битого файла → unsupported.
      if ("resource" in json && !isObj(json.resource)) {
        return { nodes, refs, ok: false, reason: 'malformed resource block: expected resource "type" "name"' };
      }
      const resources = isObj(json.resource) ? json.resource : {};
      const byType: Array<[string, Json]> = [];
      for (const [type, byName] of Object.entries(resources)) {
        if (!isObj(byName)) {
          return {
            nodes,
            refs,
            ok: false,
            reason: `malformed resource "${type}": missing second label (expected resource "type" "name")`,
          };
        }
        byType.push([type, byName]);
      }
      for (const [type, byName] of byType) {
        for (const [name, blocks] of Object.entries(byName)) {
          const id = `service:${type}.${name}`;
          nodes.push({ id, kind: "service", path: rel, name, source: TERRAFORM_ADAPTER_ID, meta: { tf_type: type } });
          const strings: string[] = [];
          collectStrings(blocks, strings);
          const refSet = new Set<string>();
          for (const s of strings) for (const r of resourceRefs(s)) refSet.add(r);
          if (refSet.size > 0) refs.push({ source: id, refs: [...refSet].sort() });
        }
      }
      return { nodes, refs, ok: true };
    })
    .catch((err: unknown) => ({
      nodes,
      refs,
      ok: false,
      reason: err instanceof Error ? err.message.split("\n")[0] : String(err),
    }));
}

async function buildDelta(
  files: string[],
  root: string,
): Promise<{ delta: GraphDelta; reasons: Record<string, string> }> {
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  const unsupported: string[] = [];
  const reasons: Record<string, string> = {};
  const allRefs: Array<{ source: string; refs: string[]; file: string }> = [];
  const nodeIds = new Set<string>();
  const edgeKeys = new Set<string>();

  for (const rel of files) {
    let text: string;
    try {
      text = readFileSync(join(root, rel), "utf8");
    } catch {
      continue; // нечитаемый — не кандидат
    }
    const res = await parseTfFile(rel, text);
    if (!res.ok) {
      unsupported.push(rel);
      reasons[rel] = res.reason ?? "hcl parse error";
      continue;
    }
    for (const n of res.nodes) {
      if (nodeIds.has(n.id)) continue;
      nodeIds.add(n.id);
      nodes.push(n);
    }
    for (const r of res.refs) allRefs.push({ ...r, file: rel });
  }

  // Рёбра references: только к целевым ресурсам, объявленным в этом скане (R20).
  for (const { source, refs, file } of allRefs) {
    for (const ref of refs) {
      const target = `service:${ref}`;
      if (!nodeIds.has(target) || target === source) continue;
      const key = `references|${source}|${target}`;
      if (edgeKeys.has(key)) continue;
      edgeKeys.add(key);
      edges.push({
        source,
        target,
        kind: "references",
        file,
        confidence: "syntax",
        meta: { dependencyTypes: ["references"] },
      });
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
  if (!terraformEnabled()) return { status: "absent", deltas: [] }; // R22
  const files = collectCandidates(ctx.root);
  if (files.length === 0) return { status: "absent", deltas: [] };
  const { delta, reasons } = await buildDelta(files, ctx.root);
  const evidence = Object.keys(reasons).length > 0 ? { unsupported_reasons: reasons } : undefined;
  return { status: "ok", deltas: [delta], evidence };
}

/** T4b: адаптер Terraform (ТЗ рев.3 §7, R19/R20/R22; MPL — только под флагом). */
export const terraformAdapter: DetailedAdapter = {
  id: TERRAFORM_ADAPTER_ID,
  get version(): string {
    return packageVersion() ?? "0.0.0";
  },
  license: "MPL-2.0",
  precision: "syntax",
  priority: 50,
  detect(ctx: ScanContext): Promise<Capability[]> {
    if (!terraformEnabled()) return Promise.resolve([]); // R22: без флага capability нет
    const files = collectCandidates(ctx.root);
    return Promise.resolve(
      files.length > 0 ? [{ id: TERRAFORM_ADAPTER_ID, confidence: "syntax", detail: `${files.length} files` }] : [],
    );
  },
  async *scan(ctx: ScanContext): AsyncIterable<GraphDelta> {
    const run = await outcome(ctx);
    if (run.status === "ok") yield* run.deltas;
  },
  outcome,
};
