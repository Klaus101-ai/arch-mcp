// T4a: общие утилиты API-адаптера (ТЗ рев.3 §7, решения R14-R17).
// R17: валидация по сети и резолв внешних $ref запрещены — URL-$ref выявляется
// по сырому тексту ДО вызова парсера и уходит в unsupported с причиной.
// R14: id узлов — service:<title>, api:<METHOD>:<path>, api:<package>.<service>/<method>,
// api:Query.<field>/api:Mutation.<field>, api:<channel>; path — файл-источник.
import type { GraphEdge, GraphNode } from "../../core/adapters/types.ts";

/** ID адаптера — он же source всех узлов и рёбер. */
export const API_ADAPTER_ID = "api";

export type DocKind = "openapi" | "swagger" | "asyncapi";

export interface DocMarker {
  kind: DocKind;
  /** Версия спецификации из ключа (3.1.0 / 2.0 / …), null — не распознана. */
  version: string | null;
}

/** Результат разбора одного файла: узлы/рёбра либо причина unsupported. */
export type FileParseResult =
  | { ok: true; nodes: GraphNode[]; edges: GraphEdge[] }
  | { ok: false; reason: string };

const YAML_MARKER = /^(openapi|swagger|asyncapi)[ \t]*:[ \t]*["']?([0-9][0-9.]*)?/m;
const JSON_MARKER = /"(openapi|swagger|asyncapi)"[ \t]*:[ \t]*["']?([0-9][0-9.]*)?/;

/** Маркер API-документа в тексте: YAML — ключ верхнего уровня, JSON — ключ корня. */
export function sniffDocMarker(text: string, ext: string): DocMarker | null {
  const m = (ext === ".json" ? JSON_MARKER : YAML_MARKER).exec(text);
  if (!m) return null;
  return { kind: m[1] as DocKind, version: m[2] ?? null };
}

const REF_RE = /\$ref["']?\s*:\s*["']?([^"'\s,}\]]+)/g;
const SCHEME_RE = /^[a-z][a-z0-9+.\-]*:/i;

/**
 * Внешние $ref (URL/схема/протокол-относительные) в сыром тексте документа.
 * Локальные указатели `#/…` и относительные файлы не считаются внешними.
 */
export function findExternalRefs(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(REF_RE)) {
    const v = m[1];
    if (v.startsWith("#")) continue;
    if (SCHEME_RE.test(v) || v.startsWith("//")) out.push(v);
  }
  return out;
}

/** Причина unsupported: однострочный текст ошибки с ограничением длины. */
export function truncateReason(msg: string): string {
  const one = String(msg).replace(/\s+/g, " ").trim();
  return one.length > 300 ? `${one.slice(0, 300)}…` : one;
}

/** Ребро api → service (R15): references, confidence syntax, файл-источник. */
export function serviceEdge(source: string, target: string, file: string): GraphEdge {
  return { source, target, kind: "references", file, confidence: "syntax" };
}

export const HTTP_METHODS = ["get", "put", "post", "delete", "options", "head", "patch", "trace"] as const;

/** Структурный вид OpenAPI/Swagger-документа для извлечения узлов (R14). */
export interface RawApiDoc {
  info?: { title?: unknown };
  paths?: Record<string, unknown>;
}

/**
 * Извлечение узлов OpenAPI/Swagger: service:<info.title> + api:<METHOD>:<path>.
 * Заголовок есть → рёбра api → service (R15); нет → узлы без рёбер.
 */
export function extractHttpApi(doc: RawApiDoc, rel: string): { nodes: GraphNode[]; edges: GraphEdge[] } {
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  const rawTitle = doc.info?.title;
  const title = typeof rawTitle === "string" && rawTitle.trim() !== "" ? rawTitle : null;
  const serviceId = title === null ? null : `service:${title}`;
  if (serviceId !== null) {
    nodes.push({ id: serviceId, kind: "service", path: rel, name: title as string, source: API_ADAPTER_ID });
  }
  const paths = doc.paths;
  if (paths !== undefined && paths !== null && typeof paths === "object") {
    for (const [p, item] of Object.entries(paths)) {
      if (item === null || typeof item !== "object") continue;
      const ops = item as Record<string, unknown>;
      for (const method of HTTP_METHODS) {
        const op = ops[method];
        if (op === null || typeof op !== "object") continue;
        const operationId = (op as { operationId?: unknown }).operationId;
        const id = `api:${method.toUpperCase()}:${p}`;
        const meta: Record<string, unknown> = { method: method.toUpperCase(), path: p };
        if (typeof operationId === "string") meta.operationId = operationId;
        nodes.push({
          id,
          kind: "api",
          path: rel,
          name: typeof operationId === "string" ? operationId : p,
          source: API_ADAPTER_ID,
          meta,
        });
        if (serviceId !== null) edges.push(serviceEdge(id, serviceId, rel));
      }
    }
  }
  return { nodes, edges };
}
