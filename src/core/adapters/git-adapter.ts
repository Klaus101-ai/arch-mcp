// T1.2b: обёртка git-адаптера (ТЗ рев.3 §4/§6; ruling R3).
// git граф НЕ даёт: только метаданные (HEAD, status lines) из WorkspaceContext
// и статус в index.adapters; scan возвращает пустую дельту.
// Внутри — ничего не запускается: факт доступности git ядро уже знает
// (inspectGit → ctx.capabilities), поэтому detect читает контекст.
import type { Adapter, Capability, ScanContext, WorkspaceContext } from "./types.ts";

/**
 * Версия обёртки (константа): бинарь git в ключ кэша/снимок не входит —
 * HEAD и status и так входят в ключ, версия бинаря — нет.
 */
export const GIT_ADAPTER_VERSION = "1.0.0";

export const gitAdapter: Adapter = {
  id: "git",
  get version(): string {
    return GIT_ADAPTER_VERSION;
  },
  license: "MIT",
  precision: "manifest",
  // Выше depcruiser (100): детерминированный порядок index.adapters — git первым
  // (контракт-тесты ожидают ["git","depcruiser"]). На конфликты графа не влияет:
  // R3 — дельта пустая, узлов/рёбер у git нет.
  priority: 150,
  detect(ctx: WorkspaceContext): Promise<Capability[]> {
    const available = ctx.capabilities.some((c) => c.id === "git");
    return Promise.resolve(
      available ? [{ id: "git", confidence: "manifest", detail: ctx.gitHead ?? "no HEAD" }] : [],
    );
  },
  // R3: пустая дельта — метаданные в конверт приходят отдельно (gitPayload).
  scan(_ctx: ScanContext): AsyncIterable<never> {
    return (async function* () {})();
  },
};
