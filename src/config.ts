import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { isExecAllowed } from "./core/exec.ts";

export type StackFilter = "py" | "jvm" | "js" | "all";

export interface ArchMcpConfig {
  /** Какие стеки учитывать в stacks/arch_snapshot. */
  stacks: StackFilter;
  /** Таймаут вызова внешних процессов (git, depcruise и будущие адаптеры), мс. */
  timeoutMs: number;
  /** Максимальный размер JSON-ответа инструмента, байт. */
  maxResponseBytes: number;
  /** Автоустановка toolchain при отсутствии (выключен по умолчанию). */
  autoInstall: boolean;
  /** Разрешён ли запуск опциональных внешних инструментов (ARCH_MCP_ALLOW_EXEC=1). */
  allowExec: boolean;
  /** Режим sqlglot: ARCH_MCP_SQLGLOT=1 && allowExec. */
  sqlglotMode: boolean;
  /** Python для моста sqlglot (ARCH_MCP_PYTHON, дефолт "python"). */
  sqlglotPython: string;
  /** Эффективный путь моста sqlglot (ARCH_MCP_SQLGLOT_BRIDGE либо <корень>/python/sqlglot_bridge.py). */
  sqlglotBridge: string;
  /** Шаблон команды SCIP-индексера (ARCH_MCP_SCIP_INDEXER, trim). */
  scipIndexer: string;
  /** Режим SCIP-индексера: шаблон непустой И ARCH_MCP_ALLOW_EXEC разрешён (ТЗ v6, п.2.1). */
  scipIndexerOn: boolean;
  /** Override каталога/файла эталонного SCIP-индекса (ARCH_MCP_SCIP_DIR, trim): адаптер читает только ctx.config. */
  scipDir: string;
}

const STACK_VALUES: readonly StackFilter[] = ["py", "jvm", "js", "all"];

/** Дефолт бюджета ответа (ТЗ рев.3, п.4): 65536. */
export const DEFAULT_MAX_RESPONSE_BYTES = 65_536;
/** Жёсткий потолок max_bytes: 1048576. Выше — BUDGET_EXCEEDED. */
export const MAX_MAX_BYTES = 1_048_576;
/** Дефолт ARCH_MCP_TIMEOUT_MS: 120000. */
export const DEFAULT_TIMEOUT_MS = 120_000;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ArchMcpConfig {
  const raw = (env.ARCH_MCP_STACKS ?? "all").trim().toLowerCase();
  const stacks = (STACK_VALUES as readonly string[]).includes(raw) ? (raw as StackFilter) : "all";
  const envBudget = positiveInt(env.ARCH_MCP_MAX_RESPONSE_BYTES, DEFAULT_MAX_RESPONSE_BYTES);
  return {
    stacks,
    timeoutMs: positiveInt(env.ARCH_MCP_TIMEOUT_MS, DEFAULT_TIMEOUT_MS),
    // env-значение выше потолка обрезается до MAX: опечатка в конфиге не должна ломать сервер.
    maxResponseBytes: Math.min(envBudget, MAX_MAX_BYTES),
    autoInstall: /^(1|true|yes|on)$/i.test((env.ARCH_MCP_AUTO_INSTALL ?? "").trim()),
    allowExec: isExecAllowed(env),
    sqlglotMode: sqlglotModeOn(env),
    sqlglotPython: (env.ARCH_MCP_PYTHON ?? "").trim() || "python",
    sqlglotBridge: resolveSqlglotBridge(env),
    scipIndexer: (env.ARCH_MCP_SCIP_INDEXER ?? "").trim(),
    scipIndexerOn: scipIndexerOn(env),
    scipDir: (env.ARCH_MCP_SCIP_DIR ?? "").trim(),
  };
}

/** Режим sqlglot строго: ARCH_MCP_SQLGLOT="1" && ARCH_MCP_ALLOW_EXEC разрешён. */
export function sqlglotModeOn(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env.ARCH_MCP_SQLGLOT ?? "").trim() === "1" && isExecAllowed(env);
}

/** Режим SCIP-индексера (ТЗ v6, п.2.1): шаблон непустой И ARCH_MCP_ALLOW_EXEC разрешён. */
export function scipIndexerOn(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env.ARCH_MCP_SCIP_INDEXER ?? "").trim() !== "" && isExecAllowed(env);
}

let defaultBridge: string | undefined;

/** Дефолтный путь моста: <корень пакета>/python/sqlglot_bridge.py (резолв как в cache.ts). */
function defaultSqlglotBridge(): string {
  if (defaultBridge === undefined) {
    const here = dirname(fileURLToPath(import.meta.url));
    const candidates = [join(here, "python", "sqlglot_bridge.py"), join(here, "..", "python", "sqlglot_bridge.py")];
    defaultBridge = candidates.find((c) => existsSync(c)) ?? candidates[1];
  }
  return defaultBridge;
}

/** Эффективный путь моста: override ARCH_MCP_SQLGLOT_BRIDGE либо дефолт пакета. */
export function resolveSqlglotBridge(env: NodeJS.ProcessEnv = process.env): string {
  const override = (env.ARCH_MCP_SQLGLOT_BRIDGE ?? "").trim();
  return override !== "" ? override : defaultSqlglotBridge();
}

function positiveInt(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}
