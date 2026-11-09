import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { delimiter, parse, resolve, sep } from "node:path";
import { ArchMcpError } from "./errors.ts";

/**
 * Разрешение workspace (ТЗ рев.3, п.2; ТЗ рев.2 — третий признак корня):
 * - workspace необязателен: git-корень от cwd (приоритетен), иначе ближайший
 *   к cwd манифест либо каталог с ≥3 файлами с исходными расширениями;
 * - мультикорень: container → roots[] найденных корней, root_used;
 * - allowlist ARCH_MCP_ALLOWED_ROOTS (path.delimiter) + авто-корень cwd;
 *   вне allowlist → WORKSPACE_NOT_FOUND;
 * - игнор при поиске корней: .gitignore + node_modules,.venv,target,dist,build,.next,out,coverage.
 */

export const DEFAULT_IGNORE: readonly string[] = [
  ".git",
  "node_modules",
  ".venv",
  "target",
  "dist",
  "build",
  ".next",
  "out",
  "coverage",
];

/** Манифесты-маркеры корня (покрывают стеки js/py/jvm из stacks.ts). */
export const MANIFESTS: readonly string[] = [
  "package.json",
  "pyproject.toml",
  "requirements.txt",
  "settings.gradle",
  "settings.gradle.kts",
  "build.gradle",
  "build.gradle.kts",
];

export interface WorkspaceResolution {
  /** Запрошенный (или найденный от cwd) workspace — база разрешения. */
  workspace: string;
  /** Найденные корни-кандидаты (для container — дочерние, отсортированы). */
  roots: string[];
  /** Корень, на котором строится индекс. */
  root_used: string;
}

export interface WorkspaceOptions {
  env?: Record<string, string | undefined>;
  cwd?: string;
}

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function normPath(p: string): string {
  const r = resolve(p);
  return process.platform === "win32" ? r.toLowerCase() : r;
}

/** child === parent или лежит внутри parent (без учёта регистра на Windows). */
function under(child: string, parent: string): boolean {
  const c = normPath(child);
  const p = normPath(parent);
  if (c === p) return true;
  return c.startsWith(p.endsWith(sep) ? p : p + sep);
}

/** Расширения исходных файлов — третий признак корня (сравнение без учёта регистра). */
const SOURCE_EXTS: readonly string[] = [
  ".sql",
  ".py",
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".kt",
  ".kts",
  ".java",
  ".go",
  ".rs",
  ".rb",
  ".php",
  ".cs",
  ".c",
  ".cpp",
  ".h",
  ".hpp",
  ".tf",
  ".proto",
  ".graphql",
  ".gql",
];

/** Порог третьего признака: не меньше трёх файлов с исходными расширениями. */
const SOURCE_MIN = 3;

/**
 * Каталог-корень: есть .git (файл или каталог), либо манифест из MANIFESTS,
 * либо в самом каталоге не меньше SOURCE_MIN файлов с исходными расширениями.
 * Ложные корни допустимы (осознанное решение, ТЗ рев.2 п.1).
 */
export function isRootDir(dir: string): boolean {
  if (existsSync(joinish(dir, ".git"))) return true;
  if (MANIFESTS.some((m) => existsSync(joinish(dir, m)))) return true;
  return countSourceFiles(dir) >= SOURCE_MIN;
}

/** Файлы с исходными расширениями в самом каталоге (без рекурсии, без учёта регистра). */
function countSourceFiles(dir: string): number {
  let n = 0;
  try {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (!e.isFile()) continue;
      const lower = e.name.toLowerCase();
      if (SOURCE_EXTS.some((x) => lower.endsWith(x))) n += 1;
      if (n >= SOURCE_MIN) break;
    }
  } catch {
    return 0;
  }
  return n;
}

function joinish(dir: string, name: string): string {
  return resolve(dir).replace(/[\\/]+$/, "") + sep + name;
}

/** Простые имена из .gitignore container (без комментариев, negation и glob). */
function readGitignoreNames(dir: string): string[] {
  const file = joinish(dir, ".gitignore");
  if (!existsSync(file)) return [];
  try {
    return readFileSync(file, "utf8")
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l !== "" && !l.startsWith("#") && !l.startsWith("!"))
      .map((l) => l.split("/")[0])
      .filter((n) => n !== "" && !n.includes("*") && !n.includes("?") && !n.includes("["));
  } catch {
    return [];
  }
}

/**
 * Корень от cwd: вверх до первого .git (git-корень приоритетен — возвращается
 * немедленно, на любом уровне); если .git не найден, возвращается запомненный
 * fallback — ближайший к cwd каталог с манифестом либо с ≥3 файлами с
 * исходными расширениями (из манифеста и третьего признака побеждает
 * ближайший к cwd); корня нет → null.
 */
export function discoverRootFrom(cwd: string): string | null {
  let dir = resolve(cwd);
  let fallback: string | null = null;
  const driveRoot = parse(dir).root;
  for (;;) {
    if (existsSync(joinish(dir, ".git"))) return dir;
    if (fallback === null && isFallbackRoot(dir)) fallback = dir;
    if (dir === driveRoot) break;
    const parent = parse(dir).dir;
    if (parent === dir || parent === "") break;
    dir = resolve(parent);
  }
  return fallback;
}

/** Fallback-корень: манифест либо третий признак (≥3 файла с исходными расширениями). */
function isFallbackRoot(dir: string): boolean {
  return MANIFESTS.some((m) => existsSync(joinish(dir, m))) || countSourceFiles(dir) >= SOURCE_MIN;
}

function assertAllowed(base: string, env: Record<string, string | undefined>, cwd: string): void {
  const raw = (env.ARCH_MCP_ALLOWED_ROOTS ?? "").trim();
  if (raw === "") return; // allowlist не задан → ограничений нет
  const entries = raw
    .split(delimiter)
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => resolve(s));
  const autoRoot = discoverRootFrom(cwd);
  const allowed = entries.some((e) => under(base, e)) || (autoRoot !== null && under(base, autoRoot));
  if (!allowed) {
    throw new ArchMcpError("WORKSPACE_NOT_FOUND", `workspace outside allowlist: ${base}`, {
      hint: `add it to ARCH_MCP_ALLOWED_ROOTS (entries joined by "${delimiter}"); current entries: ${
        entries.join(", ") || "<none>"
      }`,
    });
  }
}

/**
 * Разрешение workspace → {workspace, roots, root_used}.
 * Ошибки контракта — ArchMcpError с кодом WORKSPACE_NOT_FOUND.
 */
export function resolveWorkspace(
  requested: string | undefined,
  opts: WorkspaceOptions = {},
): WorkspaceResolution {
  const env = opts.env ?? {};
  const cwd = opts.cwd ?? process.cwd();

  if (requested === undefined || String(requested).trim() === "") {
    const root = discoverRootFrom(cwd);
    if (root === null) {
      throw new ArchMcpError("WORKSPACE_NOT_FOUND", `no git root or manifest found from cwd: ${cwd}`, {
        hint: "no git root, manifest, or ≥3 source files — run from inside a git repository, a directory with a manifest, or a directory with ≥3 source files (.ts, .sql, .py, …), or pass workspace",
      });
    }
    // Авто-корень cwd разрешён по определению — allowlist-проверка не нужна.
    return { workspace: root, roots: [root], root_used: root };
  }

  const base = resolve(String(requested).trim());
  if (!isDir(base)) {
    throw new ArchMcpError("WORKSPACE_NOT_FOUND", `workspace not found: ${requested}`, {
      hint: "pass an existing directory path, or omit workspace to discover it from cwd",
    });
  }

  assertAllowed(base, env, cwd);

  if (isRootDir(base)) return { workspace: base, roots: [base], root_used: base };

  const ignore = new Set<string>([...DEFAULT_IGNORE, ...readGitignoreNames(base)]);
  const children = readdirSync(base, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !ignore.has(e.name))
    .map((e) => resolve(base, e.name))
    .filter((d) => isRootDir(d))
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

  if (children.length === 0) {
    throw new ArchMcpError("WORKSPACE_NOT_FOUND", `no git root or manifest found under ${base}`, {
      hint: "no git root, manifest, or ≥3 source files under this directory — point workspace at a repository, a directory with a manifest (package.json, pyproject.toml, gradle), or a directory with ≥3 source files (.ts, .sql, .py, …)",
    });
  }

  const rootUsed = children.find((c) => under(cwd, c)) ?? children[0];
  return { workspace: base, roots: children, root_used: rootUsed };
}
