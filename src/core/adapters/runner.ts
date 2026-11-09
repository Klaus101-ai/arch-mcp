// T1.2b: раннер адаптера — запуск одного адаптера без исключений наружу.
// Контракт T1.2a (types.ts) не меняется: расширенный канал status/evidence —
// опциональный член DetailedAdapter.outcome, его используют адаптеры,
// управляющие внешним инструментом (depcruiser).
import type { Adapter, GraphDelta, ScanContext } from "./types.ts";

/** Расширенный результат сканирования: статус для index/missing + evidence. */
export interface AdapterOutcome {
  /** "ok" | "not_available" | "timeout" | "error" — статус попадает в index/missing. */
  status: string;
  /** Evidence внешнего инструмента (command/stderr) — опционально. */
  evidence?: unknown;
  /** Дельты адаптера (пустой массив при status "absent"/"timeout"/"error"; "not_available" у sqlglot-деградации отдаёт прежний граф). */
  deltas: GraphDelta[];
}

/** Адаптер с опциональным расширенным каналом (см. AdapterOutcome). */
export interface DetailedAdapter extends Adapter {
  outcome?(ctx: ScanContext): Promise<AdapterOutcome>;
}

export interface AdapterRun {
  adapter: Adapter;
  status: string;
  evidence?: unknown;
  /** ТЗ v6, п.2.5: причина не-ok статуса — из evidence.reason (index.adapters[].reason). */
  reason?: string;
  deltas: GraphDelta[];
}

const EMPTY_DELTA: GraphDelta = { nodes: [], edges: [], coverage: { files_seen: 0, parsed: 0, unsupported: [] } };

/** Причина из evidence.reason (ТЗ v6, п.2.5): только строка, иначе опущено. */
function evidenceReason(evidence: unknown): string | undefined {
  if (typeof evidence !== "object" || evidence === null) return undefined;
  const reason = (evidence as { reason?: unknown }).reason;
  return typeof reason === "string" && reason !== "" ? reason : undefined;
}

/**
 * Запуск одного адаптера: outcome (расширенный канал) либо detect+scan.
 * - outcome задан → статус/evidence из него (depcruiser);
 * - detect вернул [] → "unavailable" (адаптер не установлен);
 * - исключение из detect/scan → "error".
 * Никогда не бросает: падающий адаптер попадает в missing[], ядро живо.
 */
export async function runAdapter(adapter: Adapter, ctx: ScanContext): Promise<AdapterRun> {
  const detailed = adapter as DetailedAdapter;
  try {
    if (typeof detailed.outcome === "function") {
      const outcome = await detailed.outcome(ctx);
      return {
        adapter,
        status: outcome.status,
        evidence: outcome.evidence,
        reason: evidenceReason(outcome.evidence),
        deltas: outcome.deltas,
      };
    }
    const caps = await adapter.detect(ctx);
    if (caps.length === 0) return { adapter, status: "unavailable", deltas: [] };
    const deltas: GraphDelta[] = [];
    for await (const delta of adapter.scan(ctx)) deltas.push(delta);
    // Адаптер без дельт (git, R3) участвует в слиянии пустой дельтой —
    // его вклад в coverage/учёт фиксируется, граф он не меняет.
    return { adapter, status: "ok", deltas: deltas.length > 0 ? deltas : [EMPTY_DELTA] };
  } catch {
    return { adapter, status: "error", deltas: [] };
  }
}
