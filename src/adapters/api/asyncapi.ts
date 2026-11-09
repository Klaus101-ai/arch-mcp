// T4a: AsyncAPI (ТЗ рев.3 §7, R14/R15/R17).
// @asyncapi/parser@3.6.6 (Apache-2.0): parse() принимает текст документа
// (без сети; fromURL/fromFile не используются). Узлы api:<channel> (channel =
// address для 3.x, иначе ключ 2.x) и service:<info.title>; при заголовке —
// ребро api → service (R15), без заголовка — узел без ребра. Битый YAML или
// ошибки спецификации → unsupported с причиной, без исключения.
import { readFileSync } from "node:fs";
import { Parser } from "@asyncapi/parser";
import type { GraphEdge, GraphNode } from "../../core/adapters/types.ts";
import { API_ADAPTER_ID, findExternalRefs, serviceEdge, truncateReason, type FileParseResult } from "./shared.ts";

interface RawChannel {
  id(): string;
  address?(): string | undefined;
}

interface RawAsyncApiDoc {
  info(): { title(): string };
  channels?(): unknown;
}

export async function parseAsyncApiFile(absPath: string, rel: string): Promise<FileParseResult> {
  let text: string;
  try {
    text = readFileSync(absPath, "utf8");
  } catch (e) {
    return { ok: false, reason: truncateReason((e as Error).message) };
  }
  const external = findExternalRefs(text);
  if (external.length > 0) return { ok: false, reason: `external $ref: ${external[0]}` };

  let document: RawAsyncApiDoc | undefined;
  let firstError = "";
  try {
    const parser = new Parser();
    const out = await parser.parse(text);
    const errors = (out.diagnostics ?? []).filter((d) => d.severity === 0);
    firstError = errors.length > 0 ? String(errors[0].message) : "";
    document = out.document as unknown as RawAsyncApiDoc | undefined;
  } catch (e) {
    return { ok: false, reason: truncateReason((e as Error).message) };
  }
  if (!document || firstError !== "") {
    return { ok: false, reason: truncateReason(firstError || "AsyncAPI document is not parseable") };
  }

  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  let title: string | null = null;
  try {
    const t = document.info()?.title();
    title = typeof t === "string" && t.trim() !== "" ? t : null;
  } catch {
    title = null;
  }
  const serviceId = title === null ? null : `service:${title}`;
  if (serviceId !== null) {
    nodes.push({ id: serviceId, kind: "service", path: rel, name: title as string, source: API_ADAPTER_ID });
  }

  const raw = typeof document.channels === "function" ? document.channels() : undefined;
  const channels: RawChannel[] = Array.isArray(raw)
    ? raw
    : raw && typeof raw === "object"
      ? Object.values(raw)
      : [];
  for (const ch of channels) {
    let key = "";
    let address: string | undefined;
    try {
      key = ch.id();
      address = typeof ch.address === "function" ? ch.address() : undefined;
    } catch {
      continue;
    }
    const channel = address || key;
    if (!channel) continue;
    const id = `api:${channel}`;
    const meta: Record<string, unknown> = { channel: key || channel };
    if (address) meta.address = address;
    nodes.push({ id, kind: "api", path: rel, name: channel, source: API_ADAPTER_ID, meta });
    if (serviceId !== null) edges.push(serviceEdge(id, serviceId, rel));
  }
  return { ok: true, nodes, edges };
}
