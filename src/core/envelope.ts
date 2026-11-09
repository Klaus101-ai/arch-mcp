import { existsSync } from "node:fs";
import { ArchMcpError } from "./errors.ts";
import { MAX_MAX_BYTES } from "../config.ts";
import { EDGE_KINDS, KIND_EMITTERS, listAdapters } from "./adapters/registry.ts";
import type { EdgeKind, Precision } from "./adapters/types.ts";

/**
 * Конверт ответа (ТЗ рев.3, п.3):
 * успех  {ok:true,workspace,root_used,roots,schema_version,index{...},data,truncated,_meta.provenance};
 * ошибка {ok:false,error{code,message,hint,candidates?}} — см. errors.ts.
 */

/**
 * Версия схемы конверта (R25): поднимается на единицу при любом изменении
 * формы ответа (конверт, data, ошибки). GRAPH_SCHEMA_VERSION (src/cache.ts)
 * поднимается ТОЛЬКО при изменении формы графа либо структуры кэш-записи и
 * от этой константы не зависит — совместного бампа обеих больше нет.
 */
export const SCHEMA_VERSION = 6;

export interface IndexAdapter {
  name: string;
  status: string;
  version: string | null;
  /** ТЗ v6, п.2.5: причина не-ok статуса (≤200); у ok/cached поле не печатается. */
  reason?: string;
}

/** P01: статус вида рёбра в index.kinds (ТЗ рев.6, п.2). */
export type KindStatus = "emitted" | "no_matches" | "not_emitted" | "unsupported";

/** P01: строка index.kinds (ТЗ рев.6, п.1). */
export interface IndexKind {
  kind: EdgeKind;
  status: KindStatus;
  edges: number;
  confidence: Precision[];
  /** Наименее сильная precision по порядку manifest < syntax < semantic; null при пустом confidence. */
  confidence_min: Precision | null;
  emitters: string[];
}

/** P01: счётчик одного вида из merged: число рёбер и эмиттеры, чьи рёбра попали в слияние. */
export interface KindStat {
  kind: EdgeKind;
  edges: number;
  emitters: string[];
}

export interface IndexBlock {
  /**
   * "building" (ТЗ v3, п.A): arch_status не ждёт построение и отвечает
   * немедленно; при нём пустые adapters/kinds/missing и нулевая coverage —
   * легальное исключение из инварианта «kinds всегда 10» (вне building
   * инвариант сохраняется).
   */
  state: "ready" | "partial" | "building";
  progress: { percent: number; complete: boolean };
  coverage: { files_seen: number; parsed: number; unsupported: string[] };
  adapters: IndexAdapter[];
  missing: string[];
  /** P01: все 10 видов EdgeKind в каноническом порядке (ТЗ рев.6, п.1). */
  kinds: IndexKind[];
}

export interface IndexInput {
  gitAvailable: boolean;
  depcruiseStatus: string;
  depcruiseVersion: string | null;
  filesSeen: number;
  parsed: number;
  unsupported: string[];
  graphEmpty: boolean;
  /**
   * T1.2b: статусы адаптеров реестра кроме git/depcruiser (id → {status, version}).
   * Ядро всегда передаёт фактические статусы прогона; без записи статус
   * считается ok (адаптер зарегистрирован и не падал).
   */
  adapterStatuses?: Record<string, { status: string; version: string | null; reason?: string }>;
  /**
   * P01: счётчики видов рёбер из merged (ТЗ рев.6, п.1). Без записи у всех
   * видов edges=0 — блок kinds строится, но покрытие графа не отражает.
   */
  kindStats?: KindStat[];
}

/** Статусы, при которых адаптер считается работающим. */
const OK_STATUSES = new Set(["ok", "cached"]);

/** P01: статусы эмиттера, из-за которых вид становится unsupported (ТЗ рев.6, п.2). */
const BAD_KIND_STATUSES = new Set(["error", "timeout", "not_available"]);

/** P01: ранг precision для сортировки confidence: manifest < syntax < semantic. */
const PREC_RANK: Record<Precision, number> = { manifest: 0, syntax: 1, semantic: 2 };

/**
 * Блок index конверта. Состав adapters динамический — из реестра
 * (listAdapters): git/depcruiser берут статусы из legacy-полей, остальные —
 * из adapterStatuses. Блок kinds (P01) — все 10 видов EdgeKind в порядке
 * карты KIND_EMITTERS; статусы emitted/no_matches/unsupported/not_emitted —
 * ТЗ рев.6, п.2. Пустой граф, недоступный адаптер или неразобранные
 * файлы → state "partial" (не исключение — контракт п.3).
 */
export function buildIndexBlock(input: IndexInput): IndexBlock {
  const statusOf = (id: string): { status: string; version: string | null; reason?: string } => {
    if (id === "git") return { status: input.gitAvailable ? "ok" : "unavailable", version: null };
    if (id === "depcruiser") return { status: input.depcruiseStatus, version: input.depcruiseVersion };
    const given = input.adapterStatuses?.[id];
    if (given) return given;
    const registered = listAdapters().find((a) => a.id === id);
    return { status: "ok", version: registered?.version ?? null };
  };
  const adapters: IndexAdapter[] = listAdapters()
    .map((a) => ({ name: a.id, ...statusOf(a.id) }))
    // T2a: адаптер с нулём подходящих файлов (status "absent") не попадает
    // ни в adapters, ни в missing[] — индекс отражает только реально запущенное.
    .filter((a) => a.status !== "absent");
  // ТЗ v6, п.2.5: reason печатается только у не-ok статусов.
  for (const a of adapters) if (OK_STATUSES.has(a.status)) delete a.reason;
  const missing: string[] = adapters.filter((a) => !OK_STATUSES.has(a.status)).map((a) => a.name);
  const allOk = adapters.length > 0 && adapters.every((a) => OK_STATUSES.has(a.status));

  // P01 (ТЗ рев.6, п.1-2): kinds — все 10 видов EdgeKind в порядке карты.
  const stats = new Map((input.kindStats ?? []).map((s) => [s.kind, s]));
  const precisionOf = new Map(listAdapters().map((a) => [a.id, a.precision]));
  const kinds: IndexKind[] = EDGE_KINDS.map((kind) => {
    const emitters = KIND_EMITTERS[kind];
    const stat = stats.get(kind);
    const edges = stat?.edges ?? 0;
    // not_emitted: у вида нет эмиттеров в карте — известная дыра, не ошибка.
    if (emitters.length === 0) {
      return { kind, status: "not_emitted" as const, edges, confidence: [], confidence_min: null, emitters: [] };
    }
    // confidence — отсортированный массив уникальных precision эмиттеров вида.
    const confidence = [
      ...new Set(emitters.map((id) => precisionOf.get(id)).filter((p): p is Precision => p !== undefined)),
    ].sort((a, b) => PREC_RANK[a] - PREC_RANK[b]);
    const confidence_min = confidence[0] ?? null;
    if (edges > 0) {
      // emitted: только эмиттеры, чьи рёбра реально попали в merged.
      return {
        kind,
        status: "emitted" as const,
        edges,
        confidence,
        confidence_min,
        emitters: [...(stat?.emitters ?? [])],
      };
    }
    // edges = 0: unsupported — хотя бы один эмиттер не отработал; иначе no_matches.
    const unsupported = emitters.some((id) => BAD_KIND_STATUSES.has(statusOf(id).status));
    return {
      kind,
      status: unsupported ? ("unsupported" as const) : ("no_matches" as const),
      edges: 0,
      confidence,
      confidence_min,
      emitters: [...emitters],
    };
  });

  const ready = !input.graphEmpty && allOk && input.unsupported.length === 0;
  const percent =
    input.filesSeen === 0
      ? ready
        ? 100
        : 0
      : Math.max(0, Math.min(100, Math.round((input.parsed / input.filesSeen) * 100)));

  return {
    state: ready ? "ready" : "partial",
    progress: { percent, complete: ready },
    coverage: { files_seen: input.filesSeen, parsed: input.parsed, unsupported: [...input.unsupported] },
    adapters,
    missing,
    kinds,
  };
}

/**
 * Хинт building-ответа arch_status (ТЗ v3, п.A): построение идёт в фоне,
 * повторный arch_status вернёт ready/partial.
 */
export const HINT_BUILDING = "index building in background — poll arch_status until index.state is ready or partial";

/**
 * Index блок состояния "building" (ТЗ v3, п.A): arch_status не ждёт сборку.
 * Пустые adapters/kinds/missing и нулевая coverage здесь — легальное
 * исключение (README, index.kinds); progress.percent 0..100 (0 — прогон
 * только что стартовал).
 */
export function buildBuildingIndex(percent: number): IndexBlock {
  const p = Math.max(0, Math.min(100, Math.round(percent)));
  return {
    state: "building",
    progress: { percent: p, complete: false },
    coverage: { files_seen: 0, parsed: 0, unsupported: [] },
    adapters: [],
    missing: [],
    kinds: [],
  };
}

export interface EnvelopeProvenance {
  command: string;
  cwd: string;
  git_head: string | null;
  ts: string;
  cached: boolean;
  exit_code: number | null;
}

export type SuccessEnvelope = {
  ok: true;
  workspace: string;
  root_used: string;
  roots: string[];
  schema_version: number;
  index: IndexBlock;
  data: Record<string, unknown>;
  truncated: boolean;
  _meta: { provenance: EnvelopeProvenance };
};

export function successEnvelope(input: {
  workspace: string;
  root_used: string;
  roots: string[];
  index: IndexBlock;
  data: Record<string, unknown>;
  truncated: boolean;
  provenance: EnvelopeProvenance;
}): SuccessEnvelope {
  return {
    ok: true,
    workspace: input.workspace,
    root_used: input.root_used,
    roots: input.roots,
    schema_version: SCHEMA_VERSION,
    index: input.index,
    data: input.data,
    truncated: input.truncated,
    _meta: { provenance: input.provenance },
  };
}

/**
 * max_bytes вызова: необязателен; целое 1..1048576, сверх потолка —
 * BUDGET_EXCEEDED, невалидное значение — INVALID_ARGUMENT.
 */
export function resolveMaxBytes(explicit: unknown, cfgMax: number): number {
  if (explicit === undefined || explicit === null) return cfgMax;
  if (typeof explicit !== "number" || !Number.isInteger(explicit)) {
    throw new ArchMcpError("INVALID_ARGUMENT", `max_bytes must be an integer, got: ${JSON.stringify(explicit)}`, {
      hint: `pass an integer between 1 and ${MAX_MAX_BYTES}`,
    });
  }
  if (explicit < 1) {
    throw new ArchMcpError("INVALID_ARGUMENT", `max_bytes must be >= 1, got: ${explicit}`, {
      hint: `pass an integer between 1 and ${MAX_MAX_BYTES}`,
    });
  }
  if (explicit > MAX_MAX_BYTES) {
    throw new ArchMcpError("BUDGET_EXCEEDED", `max_bytes ${explicit} exceeds limit ${MAX_MAX_BYTES}`, {
      hint: `use max_bytes <= ${MAX_MAX_BYTES}`,
    });
  }
  return explicit;
}

/** Маркер идущей установки toolchain → INDEX_BUILDING. Сам маркер не трогаем. */
export function assertIndexBuilding(markerPath: string): void {
  if (existsSync(markerPath)) {
    throw new ArchMcpError("INDEX_BUILDING", `index is building: ${markerPath}`, {
      hint: "wait for npm run bootstrap to finish (marker .bootstrap-in-progress is present)",
    });
  }
}
