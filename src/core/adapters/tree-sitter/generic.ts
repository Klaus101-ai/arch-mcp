// T2b: параметризованный tree-sitter адаптер (ТЗ рев.3 §7) — 9 языков из
// таблицы languages.ts: module-узел (id = repo-relative путь) на каждый файл,
// imports-рёбра (confidence syntax) и symbol-узлы best-effort.
// Резолв цели: <каталог>/<name>.<ext> → <repo>/<name>.<ext> → уникальный
// basename; не найдено/неоднозначно → ребра нет, файла нет в рёбрах нет —
// исключения нет (кейс 2). 0 файлов → status "absent", битый wasm →
// "not_available" с hint (ядро отвечает, кейс 3).
// JS/TS здесь не эмитит ничего (R6): их адаптер — tree-sitter/tsjs.ts.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Node, Parser } from "web-tree-sitter";
import { packageVersion } from "../../../cache.ts";
import { listSourceFiles, parserFor, sortDelta, symbolId, TreeSitterUnavailable } from "./init.ts";
import type { LanguageSpec } from "./languages.ts";
import { LANGUAGES } from "./languages.ts";
import type { AdapterOutcome, DetailedAdapter } from "../runner.ts";
import type { Capability, GraphDelta, GraphEdge, GraphNode, ScanContext } from "../types.ts";

interface SymbolDecl {
  name: string;
  line: number;
}

interface ImportDecl {
  target: string;
  line: number;
}

function dirnamePosix(rel: string): string {
  const i = rel.lastIndexOf("/");
  return i < 0 ? "" : rel.slice(0, i);
}

/** Нормализация цели импорта: разделители языка → "/", без пустых сегментов. */
function normalizeTarget(raw: string, separators: readonly string[]): string {
  let s = raw.trim();
  for (const sep of separators) s = s.split(sep).join("/");
  return s
    .replace(/\/+/g, "/")
    .replace(/^\.\//, "")
    .replace(/\/+$/, "");
}

/** Склейка каталога файла и относительной цели с разрешением "." / "..". */
function joinPosix(dir: string, rel: string): string {
  const stack = dir === "" ? [] : dir.split("/");
  for (const seg of rel.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") stack.pop();
    else stack.push(seg);
  }
  return stack.join("/");
}

/**
 * Эвристика резолва (ТЗ рев.3 §7): <каталог>/<name>.<ext>, затем корень
 * репозитория, затем уникальный basename. Цель без расширения получает
 * primaryExt; с «чужим» расширением идёт как есть. Неоднозначно/нет → null.
 */
function resolveTarget(
  name: string,
  dir: string,
  files: ReadonlySet<string>,
  spec: LanguageSpec,
): string | null {
  const norm = normalizeTarget(name, spec.separators);
  if (norm === "" || /\s/.test(norm)) return null;
  const base = norm.slice(norm.lastIndexOf("/") + 1);
  const suffixed = /\.[A-Za-z0-9]+$/.test(base) ? norm : `${norm}${spec.primaryExt}`;
  const baseName = suffixed.slice(suffixed.lastIndexOf("/") + 1);
  const dirCandidate = joinPosix(dir, suffixed);
  if (dirCandidate !== "" && files.has(dirCandidate)) return dirCandidate;
  if (files.has(suffixed)) return suffixed;
  const hits: string[] = [];
  for (const f of files) {
    if (f === baseName || f.endsWith(`/${baseName}`)) hits.push(f);
  }
  hits.sort();
  return hits.length === 1 ? hits[0] : null;
}

/** Очистка извлечённого имени: без пробелов, generics и квалификаторов. */
function cleanName(raw: string): string | null {
  let t = raw.trim().replace(/<[^<>]*>/g, "");
  const i = t.lastIndexOf("::");
  if (i >= 0) t = t.slice(i + 2);
  if (t === "" || /\s/.test(t)) return null;
  return t;
}

/**
 * Имя символа best-effort: поле "name" (Go/Java/Rust/PHP/Ruby/C#), затем
 * первый идентификатор поддерева (C/C++: цепочка declarator).
 */
function nameOf(node: Node): string | null {
  const direct = node.childForFieldName("name");
  if (direct) {
    const t = cleanName(direct.text);
    if (t) return t;
  }
  const idents = node.descendantsOfType([
    "identifier",
    "type_identifier",
    "qualified_identifier",
    "field_identifier",
    "namespace_identifier",
    "simple_identifier", // kotlin: имя без поля "name"
  ]);
  if (idents.length > 0) return cleanName(idents[0].text);
  return null;
}

/** Символы файла: узлы из таблицы, первое вхождение имени выигрывает. */
function collectSymbols(root: Node, spec: LanguageSpec): SymbolDecl[] {
  const out: SymbolDecl[] = [];
  const seen = new Set<string>();
  let nodes: Node[];
  try {
    nodes = root.descendantsOfType([...spec.symbols]);
  } catch {
    return out; // неизвестный тип узла грамматики — symbols best-effort
  }
  for (const n of nodes) {
    const name = nameOf(n);
    if (!name || seen.has(name)) continue;
    seen.add(name);
    out.push({ name, line: n.startPosition.row + 1 });
  }
  return out;
}

/** Цели импортов по правилам таблицы: группа regex 1 — цель, без неё пропуск. */
function collectImports(root: Node, spec: LanguageSpec): ImportDecl[] {
  const out: ImportDecl[] = [];
  for (const rule of spec.imports) {
    let nodes: Node[];
    try {
      nodes = root.descendantsOfType([...rule.nodes]);
    } catch {
      continue; // неизвестный тип узла — правило пропускается
    }
    for (const n of nodes) {
      const m = rule.match.exec(n.text);
      if (m && m[1]) out.push({ target: m[1], line: n.startPosition.row + 1 });
    }
  }
  return out;
}

/** Обход файлов языка → дельта: module на каждый файл, imports/symbol best-effort. */
async function buildDelta(spec: LanguageSpec, root: string, files: string[]): Promise<GraphDelta> {
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  const edgeKeys = new Set<string>();
  const unsupported: string[] = [];
  const fileSet = new Set(files);
  let parser: Parser | null = null;
  try {
    parser = await parserFor(spec.grammar);
    let processed = 0;
    for (const rel of files) {
      // Кооперативная пауза (ТЗ рев.2 п.1): чтение + парс синхронные, каждые
      // 8 файлов отдаём ход event loop — параллельные запросы обслуживаются
      // во время построения графа.
      if (++processed % 8 === 0) await new Promise<void>((resolve) => setImmediate(resolve));
      nodes.push({
        id: rel,
        kind: "module",
        path: rel,
        name: rel.slice(rel.lastIndexOf("/") + 1),
        source: spec.adapterId,
      });
      let text: string;
      try {
        text = readFileSync(join(root, rel), "utf8");
      } catch {
        unsupported.push(rel);
        continue;
      }
      const tree = parser.parse(text);
      if (!tree) {
        unsupported.push(rel);
        continue;
      }
      try {
        const rootNode = tree.rootNode;
        const dir = dirnamePosix(rel);
        for (const s of collectSymbols(rootNode, spec)) {
          nodes.push({
            id: symbolId(rel, s.name),
            kind: "symbol",
            path: rel,
            name: s.name,
            source: spec.adapterId,
          });
        }
        for (const imp of collectImports(rootNode, spec)) {
          const target = resolveTarget(imp.target, dir, fileSet, spec);
          if (!target) continue; // неразрешимо → ребра нет, файл уже в coverage
          const key = JSON.stringify([rel, target, "imports"]);
          if (edgeKeys.has(key)) continue;
          edgeKeys.add(key);
          edges.push({
            source: rel,
            target,
            kind: "imports",
            file: rel,
            line: imp.line,
            confidence: "syntax",
            meta: {},
          });
        }
      } finally {
        tree.delete();
      }
    }
  } finally {
    parser?.delete();
  }
  const sorted = sortDelta(nodes, edges);
  return {
    nodes: sorted.nodes,
    edges: sorted.edges,
    coverage: {
      files_seen: files.length,
      parsed: files.length - unsupported.length,
      unsupported: [...unsupported].sort(),
    },
  };
}

/**
 * Фабрика адаптера языка: 0 файлов → "absent" (не попадает в index/missing),
 * битая грамматика → "not_available" с hint, прочее → исключение (error).
 */
export function createLanguageAdapter(spec: LanguageSpec): DetailedAdapter {
  const exts = new Set(spec.exts);

  async function outcome(ctx: ScanContext): Promise<AdapterOutcome> {
    const files = listSourceFiles(ctx.root, exts);
    if (files.length === 0) return { status: "absent", deltas: [] };
    try {
      return { status: "ok", deltas: [await buildDelta(spec, ctx.root, files)] };
    } catch (err) {
      if (err instanceof TreeSitterUnavailable) {
        return { status: "not_available", evidence: { hint: err.hint, message: err.message }, deltas: [] };
      }
      throw err;
    }
  }

  return {
    id: spec.adapterId,
    get version(): string {
      return packageVersion() ?? "0.0.0";
    },
    license: "MIT",
    precision: "syntax",
    priority: 50,
    detect(ctx: ScanContext): Promise<Capability[]> {
      const files = listSourceFiles(ctx.root, exts);
      return Promise.resolve(
        files.length > 0
          ? [{ id: spec.adapterId, confidence: "syntax", detail: `${files.length} files` }]
          : [],
      );
    },
    async *scan(ctx: ScanContext): AsyncIterable<GraphDelta> {
      const run = await outcome(ctx);
      if (run.status === "ok") yield* run.deltas;
    },
    outcome,
  };
}

/** 9 универсальных адаптеров таблицы LANGUAGES (порядок таблицы). */
export const treeSitterLanguageAdapters: readonly DetailedAdapter[] = LANGUAGES.map(createLanguageAdapter);
