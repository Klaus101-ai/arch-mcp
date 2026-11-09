// T2a: инициализация WASM tree-sitter (ТЗ рев.3 §7/§6).
// Канал грамматик (R7): только MIT-wasm из grammars/ (тексты и SPDX —
// grammars/LICENSE, хэши — grammars/SHA256SUMS). ARCH_MCP_GRAMMAR_DIR —
// override каталога грамматик: тест подкладывает битый wasm во временную
// копию, репозиторий не трогается. Несовпадение ABI (13–15) либо битый
// файл → TreeSitterUnavailable с hint: адаптер отвечает status=not_available,
// ядро не падает (контракт runner.ts: исключений наружу нет).
import { existsSync, readdirSync, type Dirent } from "node:fs";
import { createRequire } from "node:module";
import { dirname, extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Language, Parser } from "web-tree-sitter";
import type { GraphEdge, GraphNode } from "../types.ts";

/** Поддерживаемый диапазон ABI языковых грамматик (ТЗ рев.3 §7). */
export const ABI_MIN = 13;
export const ABI_MAX = 15;

// T2b: +9 универсальных языков (ТЗ рев.3 §7) — файл grammars/tree-sitter-<id>.wasm.
export type GrammarId =
  | "typescript"
  | "tsx"
  | "javascript"
  | "python"
  | "go"
  | "rust"
  | "java"
  | "kotlin"
  | "csharp"
  | "php"
  | "ruby"
  | "c"
  | "cpp";

/** Hint для index/missing при недоступности грамматики. */
export const GRAMMAR_HINT =
  "grammar wasm missing/corrupt or ABI outside 13-15 — restore grammars/ (see grammars/SHA256SUMS)";

/** Недоступность канала грамматик: сообщение + hint, без падения ядра. */
export class TreeSitterUnavailable extends Error {
  readonly hint: string;

  constructor(message: string, hint: string = GRAMMAR_HINT) {
    super(message);
    this.name = "TreeSitterUnavailable";
    this.hint = hint;
  }
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Корень пакета: в бандле import.meta.url указывает на dist/*.mjs → «..». */
function packageRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "..");
}

/** Каталог грамматик: ARCH_MCP_GRAMMAR_DIR (override) либо <корень>/grammars. */
export function grammarDir(): string {
  const override = (process.env.ARCH_MCP_GRAMMAR_DIR ?? "").trim();
  return override !== "" ? override : join(packageRoot(), "grammars");
}

const requireCjs = createRequire(import.meta.url);
let coreWasmCache: string | null | undefined;

/** Путь к ядру web-tree-sitter.wasm в node_modules (один раз на процесс). */
function coreWasmPath(): string | null {
  if (coreWasmCache === undefined) {
    try {
      const entry = requireCjs.resolve("web-tree-sitter");
      const candidate = join(dirname(entry), "web-tree-sitter.wasm");
      coreWasmCache = existsSync(candidate) ? candidate : null;
    } catch {
      coreWasmCache = null;
    }
  }
  return coreWasmCache;
}

let runtime: Promise<void> | null = null;

/** Parser.init() с явным locateFile: бандл не знает import.meta.url пакета. */
async function ensureRuntime(): Promise<void> {
  if (runtime === null) {
    runtime = (async () => {
      const wasm = coreWasmPath();
      if (wasm === null) {
        throw new TreeSitterUnavailable("web-tree-sitter core wasm not found in node_modules");
      }
      try {
        await Parser.init({ locateFile: (path: string) => (path.endsWith(".wasm") ? wasm : path) });
      } catch (err) {
        runtime = null; // следующая попытка перезапускает инициализацию
        throw new TreeSitterUnavailable(`Parser.init failed: ${errText(err)}`);
      }
    })();
  }
  return runtime;
}

// Кэш языков: ключ включает каталог грамматик — override с битым файлом не
// подмешивает язык, загруженный из штатного каталога (и наоборот).
const languages = new Map<string, Language>();

/** Загрузка языковой грамматики + проверка ABI 13–15. */
export async function loadGrammar(id: GrammarId): Promise<Language> {
  const dir = grammarDir();
  const key = `${dir}|${id}`;
  const cached = languages.get(key);
  if (cached) return cached;
  await ensureRuntime();
  const file = join(dir, `tree-sitter-${id}.wasm`);
  if (!existsSync(file)) {
    throw new TreeSitterUnavailable(`grammar wasm not found: ${file}`);
  }
  let lang: Language;
  try {
    lang = await Language.load(file);
  } catch (err) {
    throw new TreeSitterUnavailable(`grammar wasm load failed (${id}): ${errText(err)}`);
  }
  let abi: number;
  try {
    abi = lang.abiVersion;
  } catch (err) {
    throw new TreeSitterUnavailable(`ABI check failed (${id}): ${errText(err)}`);
  }
  if (abi < ABI_MIN || abi > ABI_MAX) {
    throw new TreeSitterUnavailable(`grammar ${id} ABI ${abi} outside ${ABI_MIN}-${ABI_MAX}`);
  }
  languages.set(key, lang);
  return lang;
}

/** Готовый парсер для языка: init → грамматика → setLanguage (ABI). */
export async function parserFor(id: GrammarId): Promise<Parser> {
  const lang = await loadGrammar(id);
  const parser = new Parser();
  try {
    parser.setLanguage(lang);
  } catch (err) {
    parser.delete();
    throw new TreeSitterUnavailable(`setLanguage failed (${id}): ${errText(err)}`);
  }
  return parser;
}

/** Каталоги-артефакты и кэши: в обход источников. */
const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  "coverage",
  ".next",
  "out",
  "toolchain",
  "__pycache__",
  ".venv",
  "venv",
  ".tox",
  ".mypy_cache",
  ".pytest_cache",
  ".ruff_cache",
  "vendor",
]);

/**
 * Рекурсивный обход источников: файлы с расширениями из exts, repo-relative
 * POSIX, отсортированы (детерминизм T2a-5). Каталоги из SKIP_DIRS пропускаются.
 */
export function listSourceFiles(root: string, exts: ReadonlySet<string>): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return; // недоступный каталог — не фатально
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        walk(full);
      } else if (entry.isFile() && exts.has(extname(entry.name))) {
        out.push(relative(root, full).replace(/\\/g, "/"));
      }
    }
  };
  walk(root);
  out.sort();
  return out;
}

/** ID символа: `symbol:<repo-relative путь>#<имя>` (тип id — ТЗ рев.3 §6). */
export function symbolId(relPath: string, name: string): string {
  return `symbol:${relPath}#${name}`;
}

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Детерминированный порядок дельты: узлы по id, рёбра по source/target/line. */
export function sortDelta(
  nodes: GraphNode[],
  edges: GraphEdge[],
): { nodes: GraphNode[]; edges: GraphEdge[] } {
  const sortedNodes = [...nodes].sort((a, b) => cmp(a.id, b.id));
  const sortedEdges = [...edges].sort(
    (a, b) =>
      cmp(a.source, b.source) ||
      cmp(a.target, b.target) ||
      cmp(a.kind, b.kind) ||
      cmp(a.file ?? "", b.file ?? "") ||
      (a.line ?? 0) - (b.line ?? 0),
  );
  return { nodes: sortedNodes, edges: sortedEdges };
}
