import { spawn, type ChildProcess } from "node:child_process";
import { basename } from "node:path";
import { ArchMcpError } from "./errors.ts";

/**
 * Единый запуск внешних процессов (ТЗ рев.3, п.5):
 * ARCH_MCP_TIMEOUT_MS применяется ко всем exec (git, depcruise и будущие
 * Docker/SCIP/protoc/sqlglot/kubeconform/helm); по истечении kill дерева
 * по PID (taskkill /T /F) и ошибка EXTERNAL_TOOL_FAILED{timeout_ms}.
 * Доверенное ядро (git read-only + depcruise) работает без ARCH_MCP_ALLOW_EXEC;
 * опциональные внешние инструменты требуют ARCH_MCP_ALLOW_EXEC=1.
 */

export interface ExecResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  /** Ошибка запуска (нет бинаря и т.п.). */
  spawnError: boolean;
}

export interface ExecOptions {
  cwd?: string;
  timeoutMs: number;
  maxStdout?: number;
  maxStderr?: number;
}

/**
 * Измерительный счётчик спавнов (ТЗ robustness, п.6): каждый вызов
 * runExternal увеличивает count и byCommand["<бинарь> <первый содержательный
 * аргумент>"] (git: "-C <cwd>" пропускается → "git rev-parse"/"git status"/
 * "git log"). Счётчик всегда включён (лёгкий, без аллокаций на строку),
 * сбрасывается resetSpawnStats() перед замером; реэкспорт — src/lib.ts.
 */
export const spawnStats: { count: number; byCommand: Record<string, number> } = { count: 0, byCommand: {} };

export function resetSpawnStats(): void {
  spawnStats.count = 0;
  spawnStats.byCommand = {};
}

/** Ключ записи: базовое имя бинаря + содержательный аргумент (без флагов). */
function spawnKey(file: string, args: string[]): string {
  const base = basename(file);
  let i = 0;
  if (base === "git" && args[0] === "-C") i = 2; // git -C <cwd> <подкоманда>
  const sub = args[i] ?? "";
  const name = sub === "" ? "" : basename(sub);
  return name === "" ? base : `${base} ${name}`;
}

/** Kill дерева процесса: только наш потомок по PID (по имени — никогда). */
function killTree(child: ChildProcess): void {
  try {
    if (child.pid !== undefined) {
      if (process.platform === "win32") {
        const killer = spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
        killer.on("error", () => { /* taskkill недоступен — убиваем ниже */ });
      } else {
        child.kill("SIGKILL");
      }
    }
    child.kill();
  } catch {
    /* уже завершился */
  }
}

/** Запуск процесса с таймаутом и убийством дерева; ошибки не бросает. */
export function runExternal(file: string, args: string[], opts: ExecOptions): Promise<ExecResult> {
  const maxStdout = opts.maxStdout ?? 64 * 1024 * 1024;
  const maxStderr = opts.maxStderr ?? 64 * 1024;
  return new Promise((resolvePromise) => {
    let child: ChildProcess;
    spawnStats.count += 1;
    const key = spawnKey(file, args);
    spawnStats.byCommand[key] = (spawnStats.byCommand[key] ?? 0) + 1;
    try {
      child = spawn(file, args, { cwd: opts.cwd, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    } catch (err) {
      resolvePromise({ exitCode: null, stdout: "", stderr: String(err), timedOut: false, spawnError: true });
      return;
    }

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let spawnError = false;
    let settled = false;
    let grace: ReturnType<typeof setTimeout> | undefined;

    const finish = (exitCode: number | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (grace !== undefined) clearTimeout(grace);
      resolvePromise({ exitCode, stdout, stderr, timedOut, spawnError });
    };

    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child);
      // Страховка: если close не пришёл — завершаем сами, команда не должна висеть.
      grace = setTimeout(() => finish(null), 5_000);
    }, opts.timeoutMs);

    child.stdout?.on("data", (chunk: Buffer) => {
      if (stdout.length < maxStdout) stdout += chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      if (stderr.length < maxStderr) stderr += chunk.toString("utf8");
    });
    child.on("error", (err) => {
      spawnError = true;
      stderr = `${stderr}\n${String(err)}`.trim();
    });
    child.on("close", (code) => {
      finish(typeof code === "number" ? code : null);
    });
  });
}

/** Ошибка таймаута внешнего инструмента: EXTERNAL_TOOL_FAILED{timeout_ms}. */
export function externalTimeoutError(tool: string, timeoutMs: number): ArchMcpError {
  return new ArchMcpError("EXTERNAL_TOOL_FAILED", `${tool} timed out (timeout_ms=${timeoutMs})`, {
    hint: `raise ARCH_MCP_TIMEOUT_MS (current: ${timeoutMs}) or index a smaller workspace`,
  });
}

export function isExecAllowed(env: Record<string, string | undefined>): boolean {
  return /^(1|true|yes|on)$/i.test((env.ARCH_MCP_ALLOW_EXEC ?? "").trim());
}

/** Опциональный внешний инструмент без ARCH_MCP_ALLOW_EXEC=1 → ADAPTER_UNAVAILABLE. */
export function assertExecAllowed(tool: string, env: Record<string, string | undefined>): void {
  if (!isExecAllowed(env)) {
    throw new ArchMcpError("ADAPTER_UNAVAILABLE", `${tool} requires ARCH_MCP_ALLOW_EXEC=1`, {
      hint: "trusted core (git read-only + depcruise) runs without the flag; set ARCH_MCP_ALLOW_EXEC=1 to allow optional external tools",
    });
  }
}
