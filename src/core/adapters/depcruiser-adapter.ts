// T1.2b: обёртка depcruiser-адаптера (ТЗ рев.3 §4/§6).
// Внутри — существующие runDepcruiser/depcruiseConfigPlan (src/adapters/depcruiser.ts),
// ничего не дублируется; нормализация перенесена сюда из tools/get_graph.ts
// (там осталась реэкспорт-совместимость для dist/lib.mjs и тестов).
// Узлы — module с id = repo-relative путь (R1), рёбра — imports с
// meta.dependencyTypes и meta.type_only; priority 100, license MIT,
// version — из toolchain (toolchainVersion()).
// Импорт NormalizedGraph — type из своего types-graph.ts: core/adapters
// вообще не импортирует tools/get_graph (T5.1, цикл убран).
import { existsSync } from "node:fs";
import { depcruiseJs, runDepcruiser, toolchainVersion, type DepcruiseEvidence } from "../../adapters/depcruiser.ts";
import type { NormalizedGraph } from "./types-graph.ts";
import type { AdapterOutcome, DetailedAdapter } from "./runner.ts";
import type { Adapter, Capability, GraphDelta, GraphEdge, ScanContext } from "./types.ts";

/**
 * Нормализация JSON depcruiser: modules[].source → nodes;
 * modules[].dependencies[].resolved → edges {source, target, type, meta.type_only}.
 * Принимает и объект {modules}, и «сырой» массив модулей.
 * Неразобранные модули/зависимости попадают в unsupported (coverage index).
 * (перенесено без изменений из tools/get_graph.ts, T1.2b)
 */
export function normalizeDepcruiser(data: unknown): NormalizedGraph {
  const modules: Array<{ source?: unknown; dependencies?: unknown }> = Array.isArray(data)
    ? (data as Array<{ source?: unknown; dependencies?: unknown }>)
    : typeof data === "object" && data !== null && Array.isArray((data as { modules?: unknown }).modules)
      ? ((data as { modules: Array<{ source?: unknown; dependencies?: unknown }> }).modules)
      : [];

  const nodeSet = new Set<string>();
  const edges: NormalizedGraph["edges"] = [];
  const edgeSet = new Set<string>();
  const unsupported: string[] = [];

  modules.forEach((mod, i) => {
    if (typeof mod?.source !== "string") {
      unsupported.push(`module[#${i}]: source is not a string`);
      return;
    }
    const source = mod.source;
    nodeSet.add(source);
    const deps: Array<{ resolved?: unknown; dependencyTypes?: unknown; circular?: unknown }> = Array.isArray(
      mod.dependencies,
    )
      ? (mod.dependencies as Array<{ resolved?: unknown; dependencyTypes?: unknown; circular?: unknown }>)
      : [];
    deps.forEach((dep, j) => {
      if (typeof dep?.resolved !== "string") {
        unsupported.push(`${source}: dependency[#${j}]: resolved is not a string`);
        return;
      }
      const target = dep.resolved;
      nodeSet.add(target);
      const types = Array.isArray(dep.dependencyTypes)
        ? dep.dependencyTypes.filter((t): t is string => typeof t === "string")
        : [];
      const type = types.length > 0 ? types.join(",") : "unknown";
      const typeOnly = types.includes("type-only");
      const key = `${source}\u0000${target}\u0000${type}`;
      if (edgeSet.has(key)) return;
      edgeSet.add(key);
      edges.push({ source, target, type, meta: { type_only: typeOnly } });
    });
  });
  return { nodes: [...nodeSet].sort(), edges, unsupported };
}

/** Число модулей в raw-ответе depcruiser (coverage.files_seen). */
export function moduleCount(raw: unknown): number {
  if (Array.isArray(raw)) return raw.length;
  if (typeof raw === "object" && raw !== null && Array.isArray((raw as { modules?: unknown }).modules)) {
    return ((raw as { modules: unknown[] }).modules).length;
  }
  return 0;
}

/** Циклы из depcruiser: зависимости с флагом circular. */
export function extractCircles(data: unknown): Array<{ source: string; target: string }> {
  const modules: Array<{ source?: unknown; dependencies?: unknown }> = Array.isArray(data)
    ? (data as Array<{ source?: unknown; dependencies?: unknown }>)
    : typeof data === "object" && data !== null && Array.isArray((data as { modules?: unknown }).modules)
      ? ((data as { modules: Array<{ source?: unknown; dependencies?: unknown }> }).modules)
      : [];
  const out: Array<{ source: string; target: string }> = [];
  for (const mod of modules) {
    if (typeof mod?.source !== "string") continue;
    const deps: Array<{ resolved?: unknown; circular?: unknown }> = Array.isArray(mod.dependencies)
      ? (mod.dependencies as Array<{ resolved?: unknown; circular?: unknown }>)
      : [];
    for (const dep of deps) {
      if (dep?.circular === true && typeof dep.resolved === "string") {
        out.push({ source: mod.source, target: dep.resolved });
      }
    }
  }
  return out;
}

const EMPTY_DELTA: GraphDelta = { nodes: [], edges: [], coverage: { files_seen: 0, parsed: 0, unsupported: [] } };

/**
 * raw-ответ depcruiser → GraphDelta: module-узлы (id = repo-relative путь, R1),
 * imports-рёбра с meta.dependencyTypes/meta.type_only (и meta.circular для циклов),
 * coverage {files_seen=число модулей, parsed, unsupported}.
 */
export function depcruiserDelta(raw: unknown): GraphDelta {
  const graph = normalizeDepcruiser(raw);
  const circles = new Set(extractCircles(raw).map((p) => `${p.source}\u0000${p.target}`));
  const edges: GraphEdge[] = graph.edges.map((e) => ({
    source: e.source,
    target: e.target,
    kind: "imports",
    file: e.source,
    confidence: "syntax",
    meta: {
      type_only: e.meta?.type_only === true,
      dependencyTypes: e.type === "unknown" ? [] : e.type.split(","),
      ...(circles.has(`${e.source}\u0000${e.target}`) ? { circular: true } : {}),
    },
  }));
  return {
    nodes: graph.nodes.map((id) => ({ id, kind: "module", source: "depcruiser" })),
    edges,
    coverage: { files_seen: moduleCount(raw), parsed: graph.nodes.length, unsupported: graph.unsupported ?? [] },
  };
}

/**
 * Расширенный канал адаптера: запуск depcruiser + сборка дельты.
 * Статусы — DepcruiseStatus ("ok" | "not_available" | "timeout" | "error"),
 * evidence — как у runDepcruiser (и при ошибке: команда и stderr).
 */
export async function depcruiserOutcome(ctx: ScanContext): Promise<AdapterOutcome> {
  const run = await runDepcruiser(ctx.root, ctx.timeoutMs, ctx.maxBytes);
  const delta = run.status === "ok" && run.data !== null ? depcruiserDelta(run.data) : EMPTY_DELTA;
  return { status: run.status, evidence: run.evidence, deltas: [delta] };
}

export const depcruiserAdapter: DetailedAdapter = {
  id: "depcruiser",
  get version(): string {
    // version из toolchain: "unavailable" без lock — смена инвалидирует ключ (R4).
    return toolchainVersion() ?? "unavailable";
  },
  license: "MIT",
  precision: "syntax",
  priority: 100,
  detect(): Promise<Capability[]> {
    const installed = existsSync(depcruiseJs());
    return Promise.resolve(
      installed ? [{ id: "depcruiser", confidence: "syntax", detail: toolchainVersion() ?? "no lock" }] : [],
    );
  },
  // Контрактный scan (SDK): дельта при status=ok, тишина при ошибке —
  // статус/для ядра идут через outcome; исключения сюда не пробрасываем.
  async *scan(ctx: ScanContext): AsyncIterable<GraphDelta> {
    const outcome = await depcruiserOutcome(ctx);
    if (outcome.status === "ok") yield* outcome.deltas;
  },
  outcome: depcruiserOutcome,
};

export type { DepcruiseEvidence };
