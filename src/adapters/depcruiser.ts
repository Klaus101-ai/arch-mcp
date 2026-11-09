import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runExternal } from "../core/exec.ts";
import { cacheRoot, type DepcruiseParserMode } from "../cache.ts";

export type DepcruiseStatus = "ok" | "not_available" | "timeout" | "error";

export interface DepcruiseEvidence {
  command: string;
  exit_code: number | null;
  stdout: string;
  stderr: string;
  stdout_bytes: number;
}

export interface DepcruiseResult {
  status: DepcruiseStatus;
  command: string;
  /** Точная команда установки toolchain, когда бинарь отсутствует. */
  hint?: string;
  data: unknown | null;
  evidence: DepcruiseEvidence;
}

/** Корень пакета: dist/<bundle>.mjs → <root>/dist → <root>. */
export function packageRoot(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return resolve(here, "..");
}

export function toolchainDir(root = packageRoot()): string {
  return join(root, "toolchain");
}

export function depcruiseBin(root = packageRoot()): string {
  return join(root, "toolchain", "node_modules", ".bin", "depcruise.cmd");
}

/**
 * JS-вход CLI depcruiser — тот самый файл, на который указывает
 * `<toolchain>\node_modules\.bin\depcruise.cmd`. Он же единственный вход,
 * который запускается без shell (`.cmd` напрямую без shell даёт EINVAL).
 */
export function depcruiseJs(root = packageRoot()): string {
  return join(root, "toolchain", "node_modules", "dependency-cruiser", "bin", "dependency-cruiser.mjs");
}

export interface ToolchainLock {
  package?: string;
  version?: string;
  installedAt?: string;
  packageLockSha256?: string | null;
  [k: string]: unknown;
}

export function readToolchainLock(root = packageRoot()): ToolchainLock | null {
  const file = join(toolchainDir(root), "toolchain.lock.json");
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, "utf8")) as ToolchainLock;
  } catch {
    return null;
  }
}

export function toolchainVersion(root = packageRoot()): string | null {
  const lock = readToolchainLock(root);
  return lock?.version ?? null;
}

function quoteArg(s: string): string {
  return `"${s.replace(/"/g, '\\"')}"`;
}

/**
 * Конфиг depcruiser с parser:"tsc" — единственный способ получить type-only
 * рёбра (ТЗ рев.3, п.6): дефолтный путь транспилирует TS→JS и выбрасывает
 * `import type` до парсера (доказательство: репро 2026-11-02, a.ts → 0 рёбер;
 * с config parser=tsc → a.ts -> b.ts [local,type-only,import]).
 * Файл генерируется в кэш-каталоге (вне репозитория), не в проекте.
 */
export const DEPCRUISE_CONFIG_CONTENT = `${JSON.stringify({ options: { parser: "tsc" } }, null, 2)}\n`;

/** Путь сгенерированного конфига — всегда внутри кэш-каталога, вне репозитория. */
export function depcruiseConfigPath(): string {
  return join(cacheRoot(), "depcruise.config.json");
}

/**
 * Единый источник режима парсера — и для ключа кэша (cacheKeyInput), и для
 * запуска (runDepcruiser): пишет конфиг `options.parser=tsc` в кэш-каталог
 * (см. DEPCRUISE_CONFIG_CONTENT) и возвращает `--config <файл>`; при ошибке
 * записи — детерминированный фолбэк `--no-config`. Один и тот же код выбирает
 * режим и в ключе, и в прогоне, поэтому ключ совпадает с фактическим прогоном.
 * Чужие конфиги репозитория не читаются: `--config` задаётся явно.
 */
export function depcruiseConfigPlan(): { mode: DepcruiseParserMode; args: string[]; note: string } {
  try {
    const file = depcruiseConfigPath();
    if (!existsSync(file) || readFileSync(file, "utf8") !== DEPCRUISE_CONFIG_CONTENT) {
      mkdirSync(dirname(file), { recursive: true });
      const tmp = `${file}.tmp-${process.pid}`;
      writeFileSync(tmp, DEPCRUISE_CONFIG_CONTENT, "utf8");
      renameSync(tmp, file);
    }
    return { mode: "tsc-config", args: ["--config", file], note: "" };
  } catch (err) {
    return {
      mode: "no-config",
      args: ["--no-config"],
      note: `[arch-mcp] depcruise config write failed (${String(err)}); running --no-config — type-only edges may be missing\n`,
    };
  }
}

/**
 * Вызов (не зависит от cwd процесса сервера):
 *   cwd=<repo> node <toolchain>\node_modules\dependency-cruiser\bin\dependency-cruiser.mjs
 *   --output-type json --config <кэш>/depcruise.config.json --exclude node_modules .
 *
 * `.` при cwd=repo: depcruiser резолвит цель относительно cwd, поэтому
 * абсолютный путь склеивался с cwd вызывающего процесса и давал
 * `ENOENT ... stat 'C:\Users\Андрей\E:\…'` → nodes=0, exit_code=1
 * (дефект 02.11.2026, воспроизведён при cwd сервера C:\Users\Андрей).
 *
 * `--exclude node_modules` — отклонение от ТЗ-строки, зафиксированное доказательством:
 * без него depcruiser на E:\1_siteteam\asi-agent1 (в дереве есть node_modules)
 * лезет в него и падает OOM: exit 134 через ~198 s, heap 4 ГБ (прогон 2026-11-01).
 *
 * `--config` (вместо --no-config): options.parser=tsc даёт type-only рёбра
 * (см. depcruiseConfigArgs); конфиг лежит в кэше, чужие конфиги репозитория
 * по-прежнему игнорируются.
 *
 * Запуск через общий exec-слой (src/core/exec.ts): таймаут ARCH_MCP_TIMEOUT_MS,
 * kill дерева по PID; shell:false — node.exe напрямую на JS- вход.
 */
export function runDepcruiser(
  repo: string,
  timeoutMs: number,
  maxEvidenceBytes: number,
  root: string = packageRoot(),
): Promise<DepcruiseResult> {
  const js = depcruiseJs(root);
  const { args: configArgs, note } = depcruiseConfigPlan();
  const args = ["--output-type", "json", ...configArgs, "--exclude", "node_modules", "."];
  // evidence: строка с cwd и точными аргументами (то, что реально исполняется).
  const command = `cwd=${repo} | ${[quoteArg(process.execPath), quoteArg(js), ...args].join(" ")}`;

  if (!existsSync(js)) {
    return Promise.resolve({
      status: "not_available",
      command,
      hint: "npm run bootstrap",
      data: null,
      evidence: { command, exit_code: null, stdout: "", stderr: `depcruise binary not found: ${js}`, stdout_bytes: 0 },
    });
  }

  return runExternal(process.execPath, [js, ...args], {
    cwd: repo,
    timeoutMs,
    maxStdout: 64 * 1024 * 1024,
    maxStderr: 64 * 1024,
  }).then((res) => {
    let status: DepcruiseStatus = res.timedOut
      ? "timeout"
      : res.spawnError
        ? "error"
        : res.exitCode === 0
          ? "ok"
          : "error";
    let stderr = note + res.stderr;
    if (res.spawnError && stderr === "") stderr = "failed to spawn depcruiser";
    let data: unknown = null;
    if (status === "ok") {
      try {
        data = JSON.parse(res.stdout);
      } catch {
        status = "error";
        stderr = (stderr + "\nstdout is not valid JSON").trim();
      }
    }
    const evCap = Math.max(512, Math.min(4000, Math.floor(maxEvidenceBytes / 4)));
    const stdoutBytes = Buffer.byteLength(res.stdout, "utf8");
    const evidence: DepcruiseEvidence = {
      command,
      exit_code: res.exitCode,
      stdout: res.stdout.length > evCap ? res.stdout.slice(0, evCap) + "\n…[truncated]" : res.stdout,
      stderr: stderr.length > evCap ? stderr.slice(0, evCap) + "\n…[truncated]" : stderr,
      stdout_bytes: stdoutBytes,
    };
    return { status, command, data, evidence };
  });
}
