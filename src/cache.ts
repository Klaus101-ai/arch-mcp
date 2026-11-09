import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Кэш только читает репозиторий (git + mtime изменённых файлов) и пишет
 * исключительно в %LOCALAPPDATA%\arch-mcp\cache\<sha1(repo)> — репозиторий не меняется.
 */

/**
 * Версия схемы графа/нормализации/структуры кэша. Входит в ключ кэша.
 * Бамп обязателен при любом изменении формы графа, нормализации путей,
 * структуры кэш-записи или адаптеров — правило зафиксировано в README.
 * graph-4 (2026-11-02): в ключ добавлен режим парсера depcruiser (parser).
 * graph-5 (2026-11-03, T1.2b): GraphCacheEntry хранит слияние дельт адаптеров
 * (merged с meta.adapters/contributors) вместо raw-ответа depcruiser;
 * в ключ добавлена подпись состава адаптеров (adapterSignature).
 * graph-7 (2026-11-05, sqlglot): граф дополнен метой режима sqlglot
 * (ctas/materialized/columns/stub/via=alter), в ключ кэша добавлены
 * sqlglotMode/sqlglotPython/sqlglotBridge (configHashes в get_graph.ts).
 * graph-8 (2026-11-06, robustness): GraphCacheEntry дополнен статусами
 * адаптеров (adapterStatuses) и маркером деградации core (degraded{reason,ts})
 * — структура кэш-записи изменилась, бамп по правилу R25.
 * graph-9 (2026-11-07, scip-indexer): GraphCacheEntry.adapterStatuses дополнен
 * полем reason (причина not_available индексера scip, ТЗ v6 п.2.5) — структура
 * кэш-записи изменилась, бамп по правилу R25; SCHEMA_VERSION не менялся.
 */
export const GRAPH_SCHEMA_VERSION = "graph-9";

/**
 * Режим парсера depcruiser, которым получен граф: "tsc-config" — запуск с
 * `--config <кэш>/depcruise.config.json` (options.parser=tsc, type-only рёбра);
 * "no-config" — фолбэк `--no-config`, когда конфиг записать не удалось.
 * Режим входит в канонический ключ кэша: запись одного режима не отдаётся
 * по ключу другого (вердикт T1.1 2026-11-02, MAJOR «ключ не учитывает режим парсера»).
 */
export type DepcruiseParserMode = "tsc-config" | "no-config";

let memoVersion: string | null | undefined;

/** version из package.json корня пакета — второй компонент ключа кэша. */
export function packageVersion(): string | null {
  if (memoVersion !== undefined) return memoVersion;
  memoVersion = null;
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    for (const candidate of [join(here, "package.json"), join(here, "..", "package.json")]) {
      if (!existsSync(candidate)) continue;
      const parsed = JSON.parse(readFileSync(candidate, "utf8")) as { version?: unknown };
      if (typeof parsed.version === "string") {
        memoVersion = parsed.version;
        break;
      }
    }
  } catch {
    /* package.json недоступен → null, ключ остаётся валидным */
  }
  return memoVersion;
}

/**
 * Корень кэша: ARCH_MCP_CACHE_DIR (override) либо %LOCALAPPDATA%\arch-mcp\cache
 * (фолбэк — ~/.cache/arch-mcp/cache). Снимки лежат в <корень>/snapshots/.
 */
export function cacheRoot(env: NodeJS.ProcessEnv = process.env): string {
  const override = (env.ARCH_MCP_CACHE_DIR ?? "").trim();
  if (override !== "") return override;
  const base = env.LOCALAPPDATA ?? join(homedir(), ".cache");
  return join(base, "arch-mcp", "cache");
}

export function sha1Hex(text: string): string {
  return createHash("sha1").update(text, "utf8").digest("hex");
}

export function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

export function repoCacheDir(repo: string, env: NodeJS.ProcessEnv = process.env): string {
  const normalized = repo.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
  return join(cacheRoot(env), sha1Hex(normalized));
}

export interface CacheKeyInput {
  /** git HEAD или null (не-git). */
  head: string | null;
  /** mtime изменённых файлов из git status --porcelain. */
  mtimes: Array<{ path: string; mtimeMs: number }>;
  /** версия toolchain (из toolchain.lock.json) или null. */
  toolchainVersion: string | null;
  /** хэши конфигов, влияющих на результат (stacks, maxResponseBytes и т.п.). */
  configHashes: Record<string, string>;
  /** version из package.json (см. packageVersion()); null, если недоступна. */
  packageVersion: string | null;
  /** Режим парсера depcruiser (DepcruiseParserMode): tsc-config | no-config. */
  parser: DepcruiseParserMode;
  /** R4: подпись состава адаптеров (adapterSignature) — "id:version:priority" через "|". */
  adapterSignature?: string;
  /**
   * ТЗ рев.2 п.4: подпись не-git workspace — sha256 по (path, mtimeMs, size)
   * всех файлов под repo, исключая только node_modules и .git. Передаётся
   * ТОЛЬКО при head === null; для git поле опущено → канонический ключ
   * остаётся прежним (HEAD + mtimes из git status) без изменений.
   */
  workspaceSignature?: string;
}

/** Стабильный ключ: HEAD + mtimes изменённых + версия toolchain + хэши конфигов + режим парсера + подпись адаптеров + GRAPH_SCHEMA_VERSION + версия пакета. */
export function buildCacheKey(input: CacheKeyInput): string {
  const mtimes = [...input.mtimes]
    .map((m) => ({ path: m.path.replace(/\\/g, "/"), mtimeMs: m.mtimeMs }))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const configHashes = Object.fromEntries(
    Object.entries(input.configHashes).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
  );
  const canonical = JSON.stringify({
    head: input.head,
    mtimes,
    toolchainVersion: input.toolchainVersion,
    configHashes,
    parser: input.parser,
    adapterSignature: input.adapterSignature ?? "",
    // ТЗ рев.2 п.4: подпись файлов попадает в канон только когда передана
    // (не-git, head === null). При undefined ключ JSON.stringify опускает →
    // ключ git-канала байт-в-байт прежний (cache.ts:95-113 без изменений).
    workspaceSignature: input.workspaceSignature,
    graphSchemaVersion: GRAPH_SCHEMA_VERSION,
    packageVersion: input.packageVersion ?? null,
  });
  return sha256Hex(canonical);
}

export function readCache(dir: string, key: string): unknown | null {
  const file = join(dir, `${key}.json`);
  if (!existsSync(file)) return null;
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      "key" in parsed &&
      (parsed as { key: unknown }).key === key &&
      "value" in parsed
    ) {
      return (parsed as { value: unknown }).value;
    }
    return null;
  } catch {
    return null;
  }
}

/** Атомарная запись: tmp-файл + rename. Ключ попадает внутрь файла для самопроверки. */
export function writeCache(dir: string, key: string, value: unknown): void {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${key}.json`);
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify({ key, value }), "utf8");
  renameSync(tmp, file);
}

/** mtime изменённых (и untracked) файлов; только чтение репозитория. */
export function collectMtimes(repo: string, statusLines: string[]): Array<{ path: string; mtimeMs: number }> {
  const out: Array<{ path: string; mtimeMs: number }> = [];
  for (const line of statusLines) {
    const rel = line.slice(3).trim();
    if (rel === "") continue;
    const cleaned = rel.replace(/^"|"$/g, "");
    try {
      const st = statSync(join(repo, cleaned));
      out.push({ path: cleaned, mtimeMs: st.mtimeMs });
    } catch {
      // удалённый файл — mtime недоступен, фиксируем как отсутствующий
      out.push({ path: cleaned, mtimeMs: 0 });
    }
  }
  return out;
}

/** Каталоги, исключаемые из подписи не-git workspace (ТЗ рев.2 п.4: только эти два). */
const SIGNATURE_SKIP_DIRS = new Set(["node_modules", ".git"]);

/**
 * Подпись не-git workspace (ТЗ рев.2 п.4): sha256 по отсортированным строкам
 * "<repo-relative POSIX path>\t<mtimeMs>\t<size>" для всех файлов под repo.
 * Исключаются ТОЛЬКО каталоги node_modules и .git на любой глубине — зеркало
 * охвата depcruiser (README.md:245,248); .next/dist/build/out/coverage в
 * подпись входят. Смена mtime/size любого файла меняет подпись → другой
 * ключ → кэш-промах. Обход — async fs (не блокирует event loop, ТЗ п.1).
 * null — обход невозможен (нет каталога/файла): кэш в этом вызове не используется.
 */
export async function collectWorkspaceSignature(repo: string): Promise<string | null> {
  let rootStat;
  try {
    rootStat = await stat(repo);
  } catch {
    return null;
  }
  if (!rootStat.isDirectory()) return null;

  const lines: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return; // недоступный каталог — не фатально (зеркало listSourceFiles)
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (SIGNATURE_SKIP_DIRS.has(entry.name)) continue;
        await walk(full);
      } else if (entry.isFile()) {
        try {
          const st = await stat(full);
          const rel = relative(repo, full).split(sep).join("/");
          lines.push(`${rel}\t${st.mtimeMs}\t${st.size}`);
        } catch {
          // файл исчез/недоступен между readdir и stat — пропускаем
        }
      }
    }
  };
  await walk(repo);
  lines.sort();
  return sha256Hex(lines.join("\n"));
}
