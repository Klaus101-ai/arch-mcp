// T4a: OpenAPI 3.x (ТЗ рев.3 §7, R14/R15/R17).
// @readme/openapi-parser@10.0.0 (MIT): validate() по локальному пути файла
// (resolve.external=false — сеть и внешние $ref не используются), parse() —
// документ без резолва $ref. Битый YAML/невалидная спецификация → unsupported
// с причиной, без исключения.
import { readFileSync } from "node:fs";
import { parse as oasParse, validate as oasValidate } from "@readme/openapi-parser";
import {
  extractHttpApi,
  findExternalRefs,
  truncateReason,
  type FileParseResult,
  type RawApiDoc,
} from "./shared.ts";

export async function parseOpenApiFile(absPath: string, rel: string): Promise<FileParseResult> {
  let text: string;
  try {
    text = readFileSync(absPath, "utf8");
  } catch (e) {
    return { ok: false, reason: truncateReason((e as Error).message) };
  }
  const external = findExternalRefs(text);
  if (external.length > 0) return { ok: false, reason: `external $ref: ${external[0]}` };
  try {
    const result = await oasValidate(absPath, { resolve: { external: false } });
    if (!result.valid) {
      const messages = result.errors.map((e) => e.message);
      return { ok: false, reason: truncateReason(messages.join("; ") || "invalid OpenAPI document") };
    }
  } catch (e) {
    return { ok: false, reason: truncateReason((e as Error).message) };
  }
  try {
    const doc = (await oasParse(absPath, { resolve: { external: false } })) as unknown as RawApiDoc;
    const { nodes, edges } = extractHttpApi(doc, rel);
    return { ok: true, nodes, edges };
  } catch (e) {
    return { ok: false, reason: truncateReason((e as Error).message) };
  }
}
