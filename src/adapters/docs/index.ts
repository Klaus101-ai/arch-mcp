// T4b: адаптер документации (ТЗ рев.3 §7, решения R19, R20, R21, R23).
// Кандидаты: .md/.mdx (R23 — только они). Узел doc:<relative path> (R19),
// заголовки — в meta.headings (массив строк). Локальные ссылки → references
// к doc-узлам-целям, реально существующих в скане (R20); внешние ссылки
// (http/https/mailto/якорь) не резолвятся и не проверяются по сети (R23).
// Битый (NUL/бинарь или сбой парсера) → coverage.unsupported с причиной,
// без исключения. R21: module/imports не порождаются. Ноль файлов → absent.
import { readFileSync } from "node:fs";
import { dirname, join, posix } from "node:path";
import { remark } from "remark";
import { packageVersion } from "../../cache.ts";
import type { AdapterOutcome, DetailedAdapter } from "../../core/adapters/runner.ts";
import { listSourceFiles, sortDelta } from "../../core/adapters/tree-sitter/init.ts";
import type { Capability, GraphDelta, GraphEdge, GraphNode, ScanContext } from "../../core/adapters/types.ts";

export const DOCS_ADAPTER_ID = "docs";

const DOC_EXTS = new Set([".md", ".mdx"]);

/**
 * R23/гигиена: только рабочее дерево — файлы со скрытыми каталогами
 * (`.git`, `.opencode`, `.venv`, `.idea`, …) не являются документацией
 * продукта и не должны попадать в граф (иначе `search` ловит служебные
 * файлы вроде `.opencode/agents/ai-safe.md`).
 */
function isWorktreeDoc(rel: string): boolean {
  return !rel.split("/").some((seg) => seg.startsWith("."));
}

function collectCandidates(root: string): string[] {
  return listSourceFiles(root, DOC_EXTS).filter(isWorktreeDoc);
}

type Json = Record<string, unknown>;

function isObj(v: unknown): v is Json {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Текст узла mdast (рекурсивная склейка value). */
function nodeText(node: unknown): string {
  if (!isObj(node)) return "";
  const parts: string[] = [];
  if (typeof node.value === "string") parts.push(node.value);
  if (Array.isArray(node.children)) for (const child of node.children) parts.push(nodeText(child));
  return parts.join("");
}

interface Mdoc {
  headings: string[];
  links: string[];
}

/** Разбор mdast: заголовки (все уровни) и URL ссылок. */
function walkMdoc(tree: unknown, out: Mdoc): void {
  if (Array.isArray(tree)) {
    for (const item of tree) walkMdoc(item, out);
    return;
  }
  if (!isObj(tree)) return;
  if (tree.type === "heading" && typeof tree.depth === "number") {
    const text = nodeText(tree).trim();
    if (text !== "") out.headings.push(text);
  }
  if (tree.type === "link" && typeof tree.url === "string") out.links.push(tree.url);
  if (Array.isArray(tree.children)) for (const child of tree.children) walkMdoc(child, out);
}

/** Внешняя/не-путь ссылка (R23: не резолвится). */
function isExternalLink(url: string): boolean {
  if (url === "" || url.startsWith("#")) return true; // якорь
  if (url.startsWith("//")) return true; // протокол-относительная
  return /^[A-Za-z][A-Za-z0-9+.-]*:/.test(url); // схема http:, https:, mailto:, …
}

/** Локальная ссылка → repo-relative путь цели (без якоря/query); null если не путь. */
function localLinkTarget(rel: string, url: string): string | null {
  if (isExternalLink(url)) return null;
  const clean = url.split("#")[0].split("?")[0];
  if (clean === "") return null; // ссылка только на якорь
  const base = dirname(rel);
  const target = posix.normalize(base === "." ? clean : posix.join(base, clean));
  if (target.startsWith("../")) return null; // вне репозитория
  return target;
}

interface FileResult {
  nodes: GraphNode[];
  edges: GraphEdge[];
  ok: boolean;
  reason?: string;
}

function parseDoc(rel: string, text: string, docSet: ReadonlySet<string>): FileResult {
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  if (text.includes("\u0000")) {
    return { nodes, edges, ok: false, reason: "binary content (NUL byte)" };
  }
  let parsed: Mdoc;
  try {
    const tree = remark().parse(text);
    const acc: Mdoc = { headings: [], links: [] };
    walkMdoc(tree, acc);
    parsed = acc;
  } catch (err) {
    return { nodes, edges, ok: false, reason: err instanceof Error ? err.message.split("\n")[0] : String(err) };
  }
  const docId = `doc:${rel}`;
  nodes.push({
    id: docId,
    kind: "doc",
    path: rel,
    name: rel.slice(rel.lastIndexOf("/") + 1),
    source: DOCS_ADAPTER_ID,
    meta: { headings: parsed.headings },
  });
  for (const url of parsed.links) {
    const target = localLinkTarget(rel, url);
    if (target === null) continue; // внешняя/якорная — не резолвим (R23)
    if (!docSet.has(target)) continue; // цель не doc-файл этого скана — ребра нет
    edges.push({
      source: docId,
      target: `doc:${target}`,
      kind: "references",
      file: rel,
      confidence: "syntax",
      meta: { dependencyTypes: ["references"] },
    });
  }
  return { nodes, edges, ok: true };
}

function buildDelta(
  files: string[],
  root: string,
): { delta: GraphDelta; reasons: Record<string, string> } {
  const docSet = new Set(files);
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  const nodeIds = new Set<string>();
  const edgeKeys = new Set<string>();
  const unsupported: string[] = [];
  const reasons: Record<string, string> = {};

  for (const rel of files) {
    let text: string;
    try {
      text = readFileSync(join(root, rel), "utf8");
    } catch (err) {
      unsupported.push(rel);
      reasons[rel] = err instanceof Error ? err.message.split("\n")[0] : String(err);
      continue;
    }
    const res = parseDoc(rel, text, docSet);
    if (!res.ok) {
      unsupported.push(rel);
      reasons[rel] = res.reason ?? "markdown parse error";
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
  const { delta, reasons } = buildDelta(files, ctx.root);
  const evidence = Object.keys(reasons).length > 0 ? { unsupported_reasons: reasons } : undefined;
  return { status: "ok", deltas: [delta], evidence };
}

/** T4b: адаптер Markdown-документации (ТЗ рев.3 §7, R19/R20/R21/R23). */
export const docsAdapter: DetailedAdapter = {
  id: DOCS_ADAPTER_ID,
  get version(): string {
    return packageVersion() ?? "0.0.0";
  },
  license: "MIT",
  precision: "syntax",
  priority: 50,
  detect(ctx: ScanContext): Promise<Capability[]> {
    const files = collectCandidates(ctx.root);
    return Promise.resolve(
      files.length > 0 ? [{ id: DOCS_ADAPTER_ID, confidence: "syntax", detail: `${files.length} files` }] : [],
    );
  },
  async *scan(ctx: ScanContext): AsyncIterable<GraphDelta> {
    const run = await outcome(ctx);
    if (run.status === "ok") yield* run.deltas;
  },
  outcome,
};
