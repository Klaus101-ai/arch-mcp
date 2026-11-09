// T4a: GraphQL SDL (ТЗ рев.3 §7, R14/R15/R17).
// graphql@17.0.2 (MIT): parse() разбирает SDL в AST без сетевых операций.
// Узлы api:Query.<field>/api:Mutation.<field> (meta: root/field); заголовка у
// GraphQL нет → service-узла и рёбер нет (R15: узел без ребра). Битый .graphql
// → unsupported с причиной, без исключения.
import { readFileSync } from "node:fs";
import { parse as gqlParse } from "graphql";
import type { GraphNode } from "../../core/adapters/types.ts";
import { API_ADAPTER_ID, truncateReason, type FileParseResult } from "./shared.ts";

const ROOT_TYPES = new Set(["Query", "Mutation"]);

export function parseGraphQLFile(absPath: string, rel: string): FileParseResult {
  let text: string;
  try {
    text = readFileSync(absPath, "utf8");
  } catch (e) {
    return { ok: false, reason: truncateReason((e as Error).message) };
  }
  let document;
  try {
    document = gqlParse(text);
  } catch (e) {
    return { ok: false, reason: truncateReason((e as Error).message) };
  }

  const nodes: GraphNode[] = [];
  for (const def of document.definitions) {
    if (def.kind !== "ObjectTypeDefinition" && def.kind !== "ObjectTypeExtension") continue;
    const rootName = def.name.value;
    if (!ROOT_TYPES.has(rootName)) continue;
    for (const field of def.fields ?? []) {
      const fieldName = field.name.value;
      nodes.push({
        id: `api:${rootName}.${fieldName}`,
        kind: "api",
        path: rel,
        name: fieldName,
        source: API_ADAPTER_ID,
        meta: { root: rootName, field: fieldName },
      });
    }
  }
  return { ok: true, nodes, edges: [] };
}
