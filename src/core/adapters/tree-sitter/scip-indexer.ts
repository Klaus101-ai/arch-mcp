// ТЗ v6, п.2.4/2.5: запуск SCIP-индексера без shell.
// Разбор шаблона (пробелы + двойные кавычки), подстановка {root}/{out} в любом
// токене ({out} — эфемерный run-каталог <cacheDir>/scip/run-<pid>-<n>),
// проверка первого токена (.cmd/.bat → not_available без запуска), таймаут =
// ctx.timeoutMs, уборка run-каталога после успешного чтения и после сбоя.
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { runExternal } from "../../exec.ts";

/** Пустой argv шаблона (нет ни одного токена). */
export const SCIP_EMPTY_COMMAND = "scip indexer: empty command";
/** Незакрытая двойная кавычка в шаблоне. */
export const SCIP_UNTERMINATED_QUOTE = "scip indexer: unterminated quote in template";
/** Первый токен — .cmd/.bat: без shell такой файл не запускается. */
export const SCIP_UNSUPPORTED_SHELL =
  "scip indexer: .cmd/.bat unsupported — use .exe or node.exe with JS entry";
/** Причина при таймауте (ТЗ v6, п.2.5 — дословно). */
export const SCIP_TIMEOUT_REASON = "scip indexer timed out; raise ARCH_MCP_TIMEOUT_MS (indexer runs long)";

export type ScipTemplateParse = { ok: true; tokens: string[] } | { ok: false; reason: string };

/**
 * Токенизация шаблона без shell: пробелы/табы — разделители вне кавычек,
 * двойная кавычка группирует и в текст не входит; незакрытая кавычка → отказ.
 * Пустой (или только пробельный) шаблон → SCIP_EMPTY_COMMAND.
 */
export function parseScipIndexerTemplate(template: string): ScipTemplateParse {
  const tokens: string[] = [];
  let cur = "";
  let inQuote = false;
  let started = false;
  for (const ch of template) {
    if (ch === '"') {
      inQuote = !inQuote;
      started = true;
      continue;
    }
    if (!inQuote && (ch === " " || ch === "\t" || ch === "\n" || ch === "\r")) {
      if (started) {
        tokens.push(cur);
        cur = "";
        started = false;
      }
      continue;
    }
    cur += ch;
    started = true;
  }
  if (inQuote) return { ok: false, reason: SCIP_UNTERMINATED_QUOTE };
  if (started) tokens.push(cur);
  if (tokens.length === 0 || tokens.every((t) => t === "")) {
    return { ok: false, reason: SCIP_EMPTY_COMMAND };
  }
  return { ok: true, tokens };
}

/** Подстановка {root} и {out} во всех токенах (побайтово, без shell-экранирования). */
export function substituteScipTokens(tokens: string[], root: string, out: string): string[] {
  return tokens.map((t) => t.split("{root}").join(root).split("{out}").join(out));
}

let scipRunSeq = 0;

/** Эфемерный run-каталог прогона: <cacheDir>/scip/run-<pid>-<n> (n — счётчик процесса). */
export function nextScipRunDir(cacheDir: string): string {
  scipRunSeq += 1;
  return join(cacheDir, "scip", `run-${process.pid}-${scipRunSeq}`);
}

/** Уборка run-каталога: после успешного чтения индекса и после любого сбоя. */
export function cleanupScipRunDir(runDir: string): void {
  try {
    rmSync(runDir, { recursive: true, force: true });
  } catch {
    /* уже удалён */
  }
}

export type ScipIndexerPlan =
  | { ok: true; file: string; args: string[]; runDir: string }
  | { ok: false; reason: string };

/**
 * План запуска: разбор шаблона → подстановка → проверка первого токена.
 * Отказ до создания run-каталога: каталог появляется только перед спавном.
 */
export function planScipIndexer(template: string, root: string, cacheDir: string): ScipIndexerPlan {
  const parsed = parseScipIndexerTemplate(template);
  if (!parsed.ok) return parsed;
  const runDir = nextScipRunDir(cacheDir);
  const tokens = substituteScipTokens(parsed.tokens, root, runDir);
  const file = tokens[0];
  if (/\.cmd$/i.test(file) || /\.bat$/i.test(file)) return { ok: false, reason: SCIP_UNSUPPORTED_SHELL };
  return { ok: true, file, args: tokens.slice(1), runDir };
}

export interface ScipIndexerLaunch {
  ok: boolean;
  /** Причина для evidence.reason; для таймаута — SCIP_TIMEOUT_REASON дословно. */
  reason?: string;
  /** Хвост stderr (≤120 символов) для склейки «<причина>; <хвост>». */
  stderrTail?: string;
  exitCode?: number | null;
}

const stderrTail = (stderr: string): string => {
  const t = stderr.trim();
  return t.length <= 120 ? t : t.slice(-120);
};

/** Запуск плана: создаёт run-каталог, спавнит с cwd={root} и таймаутом ctx.timeoutMs. */
export async function launchScipIndexer(
  plan: { file: string; args: string[]; runDir: string },
  root: string,
  timeoutMs: number,
): Promise<ScipIndexerLaunch> {
  mkdirSync(plan.runDir, { recursive: true });
  const res = await runExternal(plan.file, plan.args, { cwd: root, timeoutMs, maxStderr: 65536 });
  const tail = stderrTail(res.stderr);
  if (res.timedOut) return { ok: false, reason: SCIP_TIMEOUT_REASON, stderrTail: tail, exitCode: res.exitCode };
  if (res.spawnError) {
    return { ok: false, reason: "scip indexer spawn failed", stderrTail: tail, exitCode: res.exitCode };
  }
  if (res.exitCode !== 0) {
    return { ok: false, reason: `scip indexer failed (exit ${res.exitCode})`, stderrTail: tail, exitCode: res.exitCode };
  }
  return { ok: true, exitCode: 0 };
}

/**
 * Склейка причины и хвоста stderr для evidence.reason (ТЗ v6, п.2.5):
 * «<причина>; <хвост stderr ≤120>», итог ≤200 символов (лимит
 * index.adapters[].reason). Таймаут возвращается дословно, без хвоста.
 */
export function scipFailureReason(launch: ScipIndexerLaunch): string {
  const cause = launch.reason ?? "scip indexer failed";
  if (cause === SCIP_TIMEOUT_REASON) return SCIP_TIMEOUT_REASON;
  const tail = launch.stderrTail ?? "";
  const joined = tail.length > 0 ? `${cause}; ${tail}` : cause;
  return joined.length > 200 ? joined.slice(0, 200) : joined;
}
