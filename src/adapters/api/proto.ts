// T4a: protobuf (ТЗ рев.3 §7, R14/R15/R17).
// protobufjs@8.8.1 (BSD-3-Clause): parse() только разбирает текст — генерация
// кода и загрузка импортов не выполняются. Узлы: service:<package>.<service> и
// api:<package>.<service>/<method> (meta: package/service/method), ребро к
// service-узлу. Битый .proto → unsupported с причиной, без исключения.
import { readFileSync } from "node:fs";
import { Namespace, Service, parse as protoParse } from "protobufjs";
import type { GraphEdge, GraphNode } from "../../core/adapters/types.ts";
import { API_ADAPTER_ID, serviceEdge, truncateReason, type FileParseResult } from "./shared.ts";

export function parseProtoFile(absPath: string, rel: string): FileParseResult {
  let text: string;
  try {
    text = readFileSync(absPath, "utf8");
  } catch (e) {
    return { ok: false, reason: truncateReason((e as Error).message) };
  }
  let pkg = "";
  let services: Service[];
  try {
    const parsed = protoParse(text);
    pkg = typeof parsed.package === "string" ? parsed.package : "";
    services = [];
    const walk = (ns: Namespace): void => {
      for (const child of ns.nestedArray ?? []) {
        if (child instanceof Service) services.push(child);
        else if (child instanceof Namespace) walk(child);
      }
    };
    walk(parsed.root);
  } catch (e) {
    return { ok: false, reason: truncateReason((e as Error).message) };
  }

  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  for (const svc of services) {
    const full = svc.fullName.replace(/^\./, "");
    const serviceId = `service:${full}`;
    nodes.push({
      id: serviceId,
      kind: "service",
      path: rel,
      name: full,
      source: API_ADAPTER_ID,
      meta: { package: pkg, service: svc.name },
    });
    for (const methodName of Object.keys(svc.methods)) {
      const id = `api:${full}/${methodName}`;
      nodes.push({
        id,
        kind: "api",
        path: rel,
        name: methodName,
        source: API_ADAPTER_ID,
        meta: { package: pkg, service: svc.name, method: methodName },
      });
      edges.push(serviceEdge(id, serviceId, rel));
    }
  }
  return { ok: true, nodes, edges };
}
