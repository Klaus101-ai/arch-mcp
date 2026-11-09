// T2b: SCIP-адаптер (ТЗ рев.3 §7): .scip из ARCH_MCP_SCIP_DIR (каталог либо
// прямой путь к файлу) либо <root>/.arch/scip/index.scip → symbol-узлы и
// references-рёбра (precision semantic, confidence semantic, priority 200).
// Файла нет → status "absent" (не в index.adapters и не в missing[]);
// битый/нечитаемый файл → "not_available". Разбор — @scip-code/scip
// (Apache-2.0) fromBinary(IndexSchema). Лучший источник (SCIP index) имеет
// приоритет 200 над синтаксическими адаптерами (50).
// ТЗ v6: при отсутствии эталона и включённом режиме (scipIndexerOn) индексер
// запускается на каждом фактическом прогоне в эфемерный run-каталог
// (scip-indexer.ts); адаптер читает конфиг только из ctx.config.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fromBinary } from "@bufbuild/protobuf";
import { IndexSchema, SymbolRole, type Occurrence } from "@scip-code/scip";
import { loadConfig } from "../../../config.ts";
import { packageVersion } from "../../../cache.ts";
import { sortDelta, TreeSitterUnavailable } from "./init.ts";
import {
  cleanupScipRunDir,
  launchScipIndexer,
  planScipIndexer,
  scipFailureReason,
} from "./scip-indexer.ts";
import type { AdapterOutcome, DetailedAdapter } from "../runner.ts";
import type { Capability, GraphDelta, GraphEdge, GraphNode, ScanContext } from "../types.ts";

export const SCIP_ADAPTER_ID = "scip";

/** Hint при нечитаемом/битом index.scip. */
export const SCIP_HINT = "index.scip missing/corrupt — regenerate via scip indexer or remove override";

/**
 * Путь к эталонному index.scip: override (ARCH_MCP_SCIP_DIR: каталог либо файл)
 * либо <root>/.arch/scip/index.scip. Адаптер передаёт override из ctx.config
 * (ТЗ v6, п.2.1); env-значение — дефолт для вызова без второго аргумента.
 */
export function scipFilePath(root: string, override: string = (process.env.ARCH_MCP_SCIP_DIR ?? "").trim()): string {
  if (override === "") return join(root, ".arch", "scip", "index.scip");
  if (override.endsWith(".scip")) return override;
  return join(override, "index.scip");
}

/** Имя символа в узле: SCIP-строка без секции после "#", последний сегмент. */
function nameFromScipSymbol(symbol: string): string {
  const bare = symbol.replace(/#.*$/, "");
  const last = bare.slice(bare.lastIndexOf("/") + 1);
  const dot = last.lastIndexOf(".");
  return dot >= 0 && dot + 1 < last.length ? last.slice(dot + 1) : last;
}

interface DefEntry {
  /** Узел-определение: id `symbol:<path>#<имя>`. */
  node: GraphNode;
  /** Строка SCIP-символа → id узла (для поиска цели references). */
  symbol: string;
}

function scipSymbolId(relPath: string, symbol: string): string {
  return `symbol:${relPath}#${nameFromScipSymbol(symbol)}`;
}

/** Нормализованный half-open диапазон {startLine,startChar,endLine,endChar} (ТЗ v6, п.2.8). */
interface NormRange {
  startLine: number;
  startChar: number;
  endLine: number;
  endChar: number;
}

/** Legacy repeated int32: 3 элемента → single, 4 → multi, иначе диапазона нет. */
function legacyRange(values: number[]): NormRange | null {
  if (values.length === 3) {
    const [startLine, startChar, endChar] = values;
    return { startLine, startChar, endLine: startLine, endChar };
  }
  if (values.length === 4) {
    const [startLine, startChar, endLine, endChar] = values;
    return { startLine, startChar, endLine, endChar };
  }
  return null;
}

/**
 * Нормализатор диапазона occurrence (ТЗ v6, п.2.8): typed приоритетнее legacy
 * (scip_pb.d.ts:1135-1139); typed single (oneof 8) → endLine=startLine;
 * typed multi (oneof 9) принимается ВСЕГДА, даже в одну строку (MUST accept,
 * scip_pb.d.ts:1090-1092); legacy range (field 1): 3 int → single, 4 int → multi;
 * длина ≠3/4 → нет диапазона.
 */
function normalizeRange(occ: Occurrence): NormRange | null {
  const typed = occ.typedRange;
  if (typed?.case === "singleLineRange") {
    return {
      startLine: typed.value.line,
      startChar: typed.value.startCharacter,
      endLine: typed.value.line,
      endChar: typed.value.endCharacter,
    };
  }
  if (typed?.case === "multiLineRange") {
    return {
      startLine: typed.value.startLine,
      startChar: typed.value.startCharacter,
      endLine: typed.value.endLine,
      endChar: typed.value.endCharacter,
    };
  }
  return legacyRange(occ.range);
}

/** Enclosing-диапазон: typedEnclosingRange (oneof 10/11, те же правила) → legacy enclosingRange (field 7). */
function normalizeEnclosingRange(occ: Occurrence): NormRange | null {
  const typed = occ.typedEnclosingRange;
  if (typed?.case === "singleLineEnclosingRange") {
    return {
      startLine: typed.value.line,
      startChar: typed.value.startCharacter,
      endLine: typed.value.line,
      endChar: typed.value.endCharacter,
    };
  }
  if (typed?.case === "multiLineEnclosingRange") {
    return {
      startLine: typed.value.startLine,
      startChar: typed.value.startCharacter,
      endLine: typed.value.endLine,
      endChar: typed.value.endCharacter,
    };
  }
  return legacyRange(occ.enclosingRange);
}

/** Containment по (line,char) half-open: start_def ≤ start_ref и end_def ≥ end_ref. */
function containsRange(def: NormRange, ref: NormRange): boolean {
  const startOk =
    def.startLine < ref.startLine || (def.startLine === ref.startLine && def.startChar <= ref.startChar);
  const endOk = def.endLine > ref.endLine || (def.endLine === ref.endLine && def.endChar >= ref.endChar);
  return startOk && endOk;
}

/** Дельта из index.scip: определения → symbol-узлы, ссылки → references-рёбра. */
function buildDelta(bytes: Buffer): GraphDelta {
  let index;
  try {
    index = fromBinary(IndexSchema, new Uint8Array(bytes));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new TreeSitterUnavailable(`index.scip parse failed: ${msg}`, SCIP_HINT);
  }
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  const globalDefs = new Map<string, DefEntry>();

  // Проход 1: определения — symbol-узлы и карта SCIP-символ → узел.
  for (const doc of index.documents) {
    const rel = doc.relativePath.replace(/\\/g, "/");
    const seen = new Set<string>();
    for (const occ of doc.occurrences) {
      if (!occ.symbol || (occ.symbolRoles & SymbolRole.Definition) === 0) continue;
      if (occ.symbol.includes("#local")) continue; // локальные символы — вне графа
      const id = scipSymbolId(rel, occ.symbol);
      if (seen.has(id)) continue;
      seen.add(id);
      const node: GraphNode = {
        id,
        kind: "symbol",
        path: rel,
        name: nameFromScipSymbol(occ.symbol),
        source: SCIP_ADAPTER_ID,
      };
      nodes.push(node);
      if (!globalDefs.has(occ.symbol)) globalDefs.set(occ.symbol, { node, symbol: occ.symbol });
    }
  }

  // Проход 2: ссылки → references от enclosing-определения (иначе единственное
  // определение документа) к глобальному определению символа.
  for (const doc of index.documents) {
    const rel = doc.relativePath.replace(/\\/g, "/");
    const defs = doc.occurrences.filter(
      (o) => o.symbol && (o.symbolRoles & SymbolRole.Definition) !== 0 && !o.symbol.includes("#local"),
    );
    for (const occ of doc.occurrences) {
      if (!occ.symbol || (occ.symbolRoles & SymbolRole.Definition) !== 0) continue;
      if (occ.symbol.includes("#local")) continue;
      const target = globalDefs.get(occ.symbol);
      if (!target) continue; // цель нигде не определена → ребра нет
      const range = normalizeRange(occ);
      let sourceId: string | null = null;
      if (range) {
        // Containment: диапазон определения — enclosing, если задан, иначе его range.
        const enclosing = defs.find((d) => {
          const dr = normalizeEnclosingRange(d) ?? normalizeRange(d);
          return dr !== null && containsRange(dr, range);
        });
        if (enclosing) sourceId = scipSymbolId(rel, enclosing.symbol);
      }
      if (sourceId === null && defs.length === 1) sourceId = scipSymbolId(rel, defs[0].symbol);
      if (sourceId === null) continue; // неоднозначный контекст → ребра нет (best-effort)
      if (sourceId === target.node.id) continue; // самоопределение — не ссылка
      const key = JSON.stringify([sourceId, target.node.id, "references"]);
      if (edges.some((e) => e.meta?.key === key)) continue;
      const edge: GraphEdge = {
        source: sourceId,
        target: target.node.id,
        kind: "references",
        file: rel,
        confidence: "semantic",
        meta: { key },
      };
      if (range) edge.line = range.startLine + 1; // 0-based → 1-based (ТЗ v6, п.2.8)
      edges.push(edge);
    }
  }

  // Локальные цели (определение не найдено) уже пропущены; узлы-мишени есть
  // из прохода 1. Дедуп узлов по id (один символ может быть определён дважды).
  const uniqueNodes = new Map<string, GraphNode>();
  for (const n of nodes) if (!uniqueNodes.has(n.id)) uniqueNodes.set(n.id, n);
  const sorted = sortDelta([...uniqueNodes.values()], edges);
  return {
    nodes: sorted.nodes,
    edges: sorted.edges,
    coverage: { files_seen: 1, parsed: 1, unsupported: [] },
  };
}

/**
 * not_available с единственным полем причины — evidence.reason (ТЗ v6, п.2.5):
 * reason ≤200 символов (лимит index.adapters[].reason), message без изменений.
 */
function scipNotAvailable(reason: string, message: string, hint: string = SCIP_HINT): AdapterOutcome {
  return {
    status: "not_available",
    evidence: {
      ...(hint !== "" ? { hint } : {}),
      message,
      reason: reason.length > 200 ? reason.slice(0, 200) : reason,
    },
    deltas: [],
  };
}

/** Чтение файла index.scip (эталон) → outcome. */
function readScipIndex(file: string): AdapterOutcome {
  let bytes: Buffer;
  try {
    bytes = readFileSync(file);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return scipNotAvailable(`index.scip read failed: ${msg}`, `index.scip read failed: ${msg}`);
  }
  return parseScipBytes(bytes);
}

/** Разбор байтов index.scip → outcome; битый файл → not_available с причиной. */
function parseScipBytes(bytes: Buffer): AdapterOutcome {
  try {
    return { status: "ok", deltas: [buildDelta(bytes)] };
  } catch (err) {
    if (err instanceof TreeSitterUnavailable) {
      return scipNotAvailable(err.message, err.message);
    }
    throw err;
  }
}

/**
 * SCIP-адаптер: файл есть → symbol/references, нет → "absent",
 * битый → "not_available" (ядро отвечает — контракт runner.ts).
 */
export const scipAdapter: DetailedAdapter = {
  id: SCIP_ADAPTER_ID,
  get version(): string {
    return packageVersion() ?? "0.0.0";
  },
  license: "Apache-2.0",
  precision: "semantic",
  priority: 200,
  detect(ctx: ScanContext): Promise<Capability[]> {
    const file = scipFilePath(ctx.root);
    return Promise.resolve(
      existsSync(file) ? [{ id: SCIP_ADAPTER_ID, confidence: "semantic", detail: file }] : [],
    );
  },
  async outcome(ctx: ScanContext): Promise<AdapterOutcome> {
    // ТЗ v6, п.2.1: конфиг прогона читается только из ctx.config; fallback на
    // env — только для legacy-вызова ScanContext без config (тесты T2b).
    const cfg = ctx.config ?? loadConfig(process.env);
    const file = scipFilePath(ctx.root, cfg.scipDir);
    // Приоритет чтения при обоих источниках — эталон: он есть → запуска нет.
    if (existsSync(file)) return readScipIndex(file);
    if (!cfg.scipIndexerOn) return { status: "absent", deltas: [] };
    // ТЗ v6, п.2.3: правила «сгенерированный есть → читаем» нет — на каждом
    // фактическом прогоне свежий run-каталог (кэш-промах сюда не попадает).
    const plan = planScipIndexer(cfg.scipIndexer, ctx.root, ctx.cacheDir);
    if (!plan.ok) return scipNotAvailable(plan.reason, plan.reason, "");
    const launch = await launchScipIndexer(plan, ctx.root, ctx.timeoutMs);
    const indexPath = join(plan.runDir, "index.scip");
    if (!launch.ok) {
      cleanupScipRunDir(plan.runDir); // уборка после сбоя (ТЗ v6, п.2.3)
      const reason = scipFailureReason(launch);
      return scipNotAvailable(reason, reason, "");
    }
    if (!existsSync(indexPath)) {
      cleanupScipRunDir(plan.runDir);
      return scipNotAvailable("scip indexer produced no index.scip", "scip indexer produced no index.scip", "");
    }
    let bytes: Buffer;
    try {
      bytes = readFileSync(indexPath);
    } catch (err) {
      cleanupScipRunDir(plan.runDir);
      const msg = err instanceof Error ? err.message : String(err);
      return scipNotAvailable(`index.scip read failed: ${msg}`, `index.scip read failed: ${msg}`, "");
    }
    cleanupScipRunDir(plan.runDir); // уборка после успешного чтения (ТЗ v6, п.2.3)
    return parseScipBytes(bytes);
  },
  async *scan(ctx: ScanContext): AsyncIterable<GraphDelta> {
    const run = await scipAdapter.outcome!(ctx);
    if (run.status === "ok") yield* run.deltas;
  },
};
