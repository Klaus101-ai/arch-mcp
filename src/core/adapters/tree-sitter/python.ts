// T2a: обход .py → module-узлы (id = repo-relative путь), imports-рёбра
// (confidence syntax) и best-effort symbol/calls.
// Резолв цели импорта: <каталог>/<name>.py, <каталог>/<name>/__init__.py,
// затем корень репозитория, затем уникальное совпадение по basename;
// неоднозначно/не найдено → ребра нет (файл остаётся в coverage, исключения
// нет — ТЗ T2a, кейс 3). Относительные импорты (level > 0) резолвятся только
// от каталога файла — на корень репозитория не откатываются.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Node, Parser } from "web-tree-sitter";
import { packageVersion } from "../../../cache.ts";
import { listSourceFiles, parserFor, sortDelta, symbolId, TreeSitterUnavailable } from "./init.ts";
import type { AdapterOutcome, DetailedAdapter } from "../runner.ts";
import type { Capability, GraphDelta, GraphEdge, GraphNode, ScanContext } from "../types.ts";

export const PYTHON_ADAPTER_ID = "tree-sitter-python";

const EXTS = new Set([".py"]);
const PY_SYMBOL_TYPES = new Set(["function_definition", "class_definition"]);
const NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const MODULE_RE = /^[A-Za-z_][A-Za-z0-9_.]*$/;

interface SymbolDecl {
  name: string;
  line: number;
}

interface CallDecl {
  caller: string;
  callee: string;
  line: number;
}

interface ImportEntry {
  /** Имя модуля: "helper", "pkg.mod" либо имя из from . import x. */
  name: string;
  /** Количество ведущих точек (0 — абсолютный импорт). */
  level: number;
}

function dirnamePosix(rel: string): string {
  const i = rel.lastIndexOf("/");
  return i < 0 ? "" : rel.slice(0, i);
}

/** Символы файла: def/class (включая вложенные). */
function collectSymbols(root: Node): SymbolDecl[] {
  const out: SymbolDecl[] = [];
  const seen = new Set<string>();
  for (const n of root.descendantsOfType([...PY_SYMBOL_TYPES])) {
    const nameNode = n.childForFieldName("name");
    const name = nameNode ? nameNode.text : null;
    if (!name || !NAME_RE.test(name) || seen.has(name)) continue;
    seen.add(name);
    out.push({ name, line: n.startPosition.row + 1 });
  }
  return out;
}

/** Ближайший def/class, обрамляющий вызов (source ребра calls). */
function enclosingSymbol(call: Node): string | null {
  let cur = call.parent;
  while (cur) {
    if (PY_SYMBOL_TYPES.has(cur.type)) {
      const nameNode = cur.childForFieldName("name");
      if (nameNode) return nameNode.text;
    } else if (cur.type === "module") {
      return null;
    }
    cur = cur.parent;
  }
  return null;
}

/** Вызовы по именам (best-effort): только callee, совпадающий с символом файла. */
function collectCalls(root: Node, symbols: ReadonlySet<string>): CallDecl[] {
  const out: CallDecl[] = [];
  const seen = new Set<string>();
  for (const call of root.descendantsOfType(["call"])) {
    const fn = call.childForFieldName("function");
    if (!fn) continue;
    let callee: string | null = null;
    if (fn.type === "identifier") callee = fn.text;
    else if (fn.type === "attribute") {
      const attr = fn.childForFieldName("attribute");
      if (attr) callee = attr.text;
    }
    if (!callee || !NAME_RE.test(callee) || !symbols.has(callee)) continue;
    const caller = enclosingSymbol(call);
    if (!caller || caller === callee) continue;
    const key = JSON.stringify([caller, callee]);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ caller, callee, line: call.startPosition.row + 1 });
  }
  return out;
}

/**
 * Разбор текста импорта: import a.b[, c] → level 0; from <имя> import … →
 * level по точкам; from . import x[, y] → имена модулей на level.
 */
function parseImportNames(text: string): ImportEntry[] {
  const out: ImportEntry[] = [];
  const from = /^from\s+(\.*)([A-Za-z_][A-Za-z0-9_.]*)?\s+import\s+([\s\S]+)$/.exec(text);
  if (from) {
    const level = from[1].length;
    const module = from[2] ?? "";
    if (module !== "" && MODULE_RE.test(module)) {
      out.push({ name: module, level });
      return out;
    }
    for (const raw of from[3].split(",")) {
      const token = raw.trim().split(/\s+/)[0] ?? "";
      if (NAME_RE.test(token)) out.push({ name: token, level });
    }
    return out;
  }
  const plain = /^import\s+([\s\S]+)$/.exec(text);
  if (plain) {
    for (const raw of plain[1].split(",")) {
      const token = raw.trim().split(/\s+/)[0] ?? "";
      if (MODULE_RE.test(token)) out.push({ name: token, level: 0 });
    }
  }
  return out;
}

/**
 * Резолв импорта в repo-relative путь: каталог файла → корень репозитория
 * (level 0), затем уникальный basename; не найдено/неоднозначно → null.
 */
function resolveImportTarget(
  name: string,
  level: number,
  dir: string,
  files: ReadonlySet<string>,
): string | null {
  const parts = name.split(".").filter((p) => p !== "");
  const relPath = parts.join("/");
  const candidates: string[] = [];
  const push = (base: string, suffix: string): void => {
    const candidate = base === "" ? suffix : `${base}/${suffix}`;
    if (!candidates.includes(candidate)) candidates.push(candidate);
  };
  if (level > 0) {
    let base = dir;
    for (let i = 1; i < level; i += 1) {
      const idx = base.lastIndexOf("/");
      base = idx < 0 ? "" : base.slice(0, idx);
    }
    if (relPath !== "") {
      push(base, `${relPath}.py`);
      push(base, `${relPath}/__init__.py`);
    }
  } else {
    push(dir, `${relPath}.py`);
    push(dir, `${relPath}/__init__.py`);
    push("", `${relPath}.py`);
    push("", `${relPath}/__init__.py`);
  }
  for (const candidate of candidates) {
    if (files.has(candidate)) return candidate;
  }
  if (level === 0 && parts.length > 0) {
    const base = `${parts[parts.length - 1]}.py`;
    const hits: string[] = [];
    for (const f of files) {
      if (f === base || f.endsWith(`/${base}`)) hits.push(f);
    }
    hits.sort();
    if (hits.length === 1) return hits[0];
  }
  return null;
}

/** Обход .py → дельта: module-узлы на каждый файл, imports/calls best-effort. */
async function buildDelta(root: string, files: string[]): Promise<GraphDelta> {
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  const edgeKeys = new Set<string>();
  const unsupported: string[] = [];
  const fileSet = new Set(files);
  let parser: Parser | null = null;
  try {
    parser = await parserFor("python");
    let processed = 0;
    for (const rel of files) {
      // Кооперативная пауза (ТЗ рев.2 п.1): чтение + парс синхронные, каждые
      // 8 файлов отдаём ход event loop — соседние запросы не ждут весь прогон.
      if (++processed % 8 === 0) await new Promise<void>((resolve) => setImmediate(resolve));
      nodes.push({
        id: rel,
        kind: "module",
        path: rel,
        name: rel.slice(rel.lastIndexOf("/") + 1),
        source: PYTHON_ADAPTER_ID,
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
        const symbols = collectSymbols(rootNode);
        const names = new Set(symbols.map((s) => s.name));
        for (const s of symbols) {
          nodes.push({
            id: symbolId(rel, s.name),
            kind: "symbol",
            path: rel,
            name: s.name,
            source: PYTHON_ADAPTER_ID,
          });
        }
        for (const n of rootNode.descendantsOfType(["import_statement", "import_from_statement"])) {
          const line = n.startPosition.row + 1;
          for (const entry of parseImportNames(n.text)) {
            const target = resolveImportTarget(entry.name, entry.level, dir, fileSet);
            if (!target) continue; // неразрешимо → ребра нет, файл уже в coverage
            const key = JSON.stringify([rel, target, "imports"]);
            if (edgeKeys.has(key)) continue;
            edgeKeys.add(key);
            edges.push({
              source: rel,
              target,
              kind: "imports",
              file: rel,
              line,
              confidence: "syntax",
              meta: {},
            });
          }
        }
        for (const c of collectCalls(rootNode, names)) {
          const source = symbolId(rel, c.caller);
          const target = symbolId(rel, c.callee);
          const key = JSON.stringify([source, target, "calls"]);
          if (edgeKeys.has(key)) continue;
          edgeKeys.add(key);
          edges.push({
            source,
            target,
            kind: "calls",
            file: rel,
            line: c.line,
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
 * Расширенный канал: 0 .py → "absent" (не попадает в index/missing),
 * битая грамматика → "not_available" с hint, прочее → исключение (error).
 */
async function outcome(ctx: ScanContext): Promise<AdapterOutcome> {
  const files = listSourceFiles(ctx.root, EXTS);
  if (files.length === 0) return { status: "absent", deltas: [] };
  try {
    return { status: "ok", deltas: [await buildDelta(ctx.root, files)] };
  } catch (err) {
    if (err instanceof TreeSitterUnavailable) {
      return { status: "not_available", evidence: { hint: err.hint, message: err.message }, deltas: [] };
    }
    throw err;
  }
}

export const treeSitterPythonAdapter: DetailedAdapter = {
  id: PYTHON_ADAPTER_ID,
  get version(): string {
    return packageVersion() ?? "0.0.0";
  },
  license: "MIT",
  precision: "syntax",
  priority: 50,
  detect(ctx: ScanContext): Promise<Capability[]> {
    const files = listSourceFiles(ctx.root, EXTS);
    return Promise.resolve(
      files.length > 0 ? [{ id: PYTHON_ADAPTER_ID, confidence: "syntax", detail: `${files.length} files` }] : [],
    );
  },
  async *scan(ctx: ScanContext): AsyncIterable<GraphDelta> {
    const run = await outcome(ctx);
    if (run.status === "ok") yield* run.deltas;
  },
  outcome,
};
