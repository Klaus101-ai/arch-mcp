// T4a: Swagger 2.0 / OpenAPI 3.0 (ТЗ рев.3 §7, R14/R15/R17).
// @apidevtools/swagger-parser@13.1.0 (MIT): validate() по локальному пути файла
// (resolve.external=false — без сети и внешних $ref), возвращает разобранный
// документ. Битый JSON/YAML и невалидная спецификация → unsupported с причиной.
import { readFileSync } from "node:fs";
import SwaggerParser from "@apidevtools/swagger-parser";
import {
  extractHttpApi,
  findExternalRefs,
  truncateReason,
  type FileParseResult,
  type RawApiDoc,
} from "./shared.ts";

export async function parseSwaggerFile(absPath: string, rel: string): Promise<FileParseResult> {
  let text: string;
  try {
    text = readFileSync(absPath, "utf8");
  } catch (e) {
    return { ok: false, reason: truncateReason((e as Error).message) };
  }
  const external = findExternalRefs(text);
  if (external.length > 0) return { ok: false, reason: `external $ref: ${external[0]}` };
  try {
    const doc = (await SwaggerParser.validate(absPath, { resolve: { external: false } })) as unknown as RawApiDoc;
    const { nodes, edges } = extractHttpApi(doc, rel);
    return { ok: true, nodes, edges };
  } catch (e) {
    return { ok: false, reason: truncateReason((e as Error).message) };
  }
}
