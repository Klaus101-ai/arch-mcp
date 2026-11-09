import { externalTimeoutError, runExternal } from "../core/exec.ts";

export interface GitRunResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  /** git-бинарь не запустился (ENOENT и т.п.). */
  spawnError: boolean;
}

export interface GitInfo {
  isRepo: boolean;
  /** false — git недоступен как бинарь (не путать с каталогом без .git). */
  available: boolean;
  gitHead: string | null;
  status: string[];
  lastCommit: { hash: string; committedAt: string } | null;
  command: string;
  exitCode: number | null;
}

/**
 * Запуск git (read-only) через общий exec-слой: таймаут ARCH_MCP_TIMEOUT_MS,
 * kill дерева по PID. Ошибки не бросают — возвращают exitCode/spawnError.
 */
export function runGit(args: string[], cwd: string, timeoutMs: number): Promise<GitRunResult> {
  return runExternal("git", ["-C", cwd, ...args], {
    cwd,
    timeoutMs,
    maxStdout: 8 * 1024 * 1024,
    maxStderr: 1024 * 1024,
  });
}

/** Строки `git status --porcelain` → нормализованный список (без пустых, trim). */
export function normalizeStatusLines(raw: string): string[] {
  return raw
    .split(/\r?\n/)
    .map((l) => l.replace(/\s+$/, ""))
    .filter((l) => l.trim() !== "");
}

/** stdout `git log -1 --format=%H%n%cI` → {hash, committedAt}. */
export function parseLastCommit(raw: string): { hash: string; committedAt: string } | null {
  const lines = raw.split(/\r?\n/).map((l) => l.trim()).filter((l) => l !== "");
  if (lines.length < 2) return null;
  return { hash: lines[0], committedAt: lines[1] };
}

/**
 * Инспекция репозитория. Не-git каталог (или каталог без .git) — git_head null,
 * без падения: git rev-parse завершается ненулевым кодом.
 * Таймаут git → EXTERNAL_TOOL_FAILED{timeout_ms} (ТЗ рев.3, п.5).
 * inspectGitStats.count — spy-счётчик вызовов (ТЗ robustness, п.6): один
 * вызов runTool должен давать ровно один inspectGit (двойной вызов убран).
 */
export const inspectGitStats: { count: number } = { count: 0 };

export function resetInspectGitStats(): void {
  inspectGitStats.count = 0;
}

export async function inspectGit(repo: string, timeoutMs: number): Promise<GitInfo> {
  inspectGitStats.count += 1;
  const command = `git -C ${repo} rev-parse HEAD`;
  const head = await runGit(["rev-parse", "HEAD"], repo, timeoutMs);
  if (head.timedOut) throw externalTimeoutError("git", timeoutMs);
  if (head.spawnError) {
    return { isRepo: false, available: false, gitHead: null, status: [], lastCommit: null, command, exitCode: head.exitCode };
  }
  if (head.exitCode !== 0 || head.stdout.trim() === "") {
    return { isRepo: false, available: true, gitHead: null, status: [], lastCommit: null, command, exitCode: head.exitCode };
  }
  const statusRun = await runGit(["status", "--porcelain"], repo, timeoutMs);
  if (statusRun.timedOut) throw externalTimeoutError("git", timeoutMs);
  const logRun = await runGit(["log", "-1", "--format=%H%n%cI"], repo, timeoutMs);
  if (logRun.timedOut) throw externalTimeoutError("git", timeoutMs);
  return {
    isRepo: true,
    available: true,
    gitHead: head.stdout.trim(),
    status: normalizeStatusLines(statusRun.stdout),
    lastCommit: parseLastCommit(logRun.stdout),
    command,
    exitCode: head.exitCode,
  };
}
