// T2a: обход JS/TS (.ts/.tsx/.js/.jsx/.mjs/.cjs) → symbol-узлы и calls-рёбра.
// R6: граф импортов JS/TS принадлежит depcruiser (priority 100) — tree-sitter
// здесь НЕ эмитит module-узлы и imports-рёбра, чтобы не задвоить рёбра и не
// сдвинуть числа 226/217. Развязка с legacy-запросами: calls-рёбра соединяют
// только symbol-узлы (symbol:путь#имя), модуль-пути в них не входят —
// focus/reaches/impact/affected_tests по module-узлам не меняются (R6b).
import { readFileSync } from "node:fs";
import { extname, join } from "node:path";
import type { Node, Parser } from "web-tree-sitter";
import { packageVersion } from "../../../cache.ts";
import { listSourceFiles, parserFor, sortDelta, symbolId, TreeSitterUnavailable, type GrammarId } from "./init.ts";
import type { AdapterOutcome, DetailedAdapter } from "../runner.ts";
import type { Capability, GraphDelta, GraphEdge, GraphNode, ScanContext } from "../types.ts";

export const TSJS_ADAPTER_ID = "tree-sitter-tsjs";

const EXT_GRAMMAR: Record<string, GrammarId> = {
  ".ts": "typescript",
  ".tsx": "tsx",
  ".js": "javascript",
  ".jsx": "javascript",
  ".mjs": "javascript",
  ".cjs": "javascript",
};
const EXTS = new Set(Object.keys(EXT_GRAMMAR));

/** Типы объявлений-символов; VAR_* считаются символом только внутри export. */
const DECL_TYPES = new Set([
  "function_declaration",
  "generator_function_declaration",
  "class_declaration",
  "method_definition",
]);
const VAR_TYPES = new Set(["lexical_declaration", "variable_declaration"]);
const NAME_RE = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

interface SymbolDecl {
  name: string;
  line: number;
}

interface CallDecl {
  caller: string;
  callee: string;
  line: number;
}

/** Имя из const/let-объявления (только простой идентификатор, не деструктуризация). */
function declaratorName(decl: Node): string | null {
  for (let i = 0; i < decl.childCount; i += 1) {
    const child = decl.child(i);
    if (child && child.type === "variable_declarator") {
      const name = child.childForFieldName("name");
      if (name && NAME_RE.test(name.text)) return name.text;
      return null;
    }
  }
  return null;
}

/** Символы файла: функции/классы/методы + экспортированные переменные. */
function collectSymbols(root: Node): SymbolDecl[] {
  const out: SymbolDecl[] = [];
  const seen = new Set<string>();
  const decls = root.descendantsOfType([...DECL_TYPES, ...VAR_TYPES]);
  for (const n of decls) {
    let name: string | null = null;
    if (VAR_TYPES.has(n.type)) {
      const parent = n.parent;
      if (!parent || parent.type !== "export_statement") continue;
      name = declaratorName(n);
    } else {
      const nameNode = n.childForFieldName("name");
      name = nameNode ? nameNode.text : null;
    }
    if (!name || !NAME_RE.test(name) || seen.has(name)) continue;
    seen.add(name);
    out.push({ name, line: n.startPosition.row + 1 });
  }
  return out;
}

/** Ближайший объявленный символ, обрамляющий вызов (source ребра calls). */
function enclosingSymbol(call: Node): string | null {
  let cur = call.parent;
  while (cur) {
    if (DECL_TYPES.has(cur.type)) {
      const nameNode = cur.childForFieldName("name");
      if (nameNode && NAME_RE.test(nameNode.text)) return nameNode.text;
    } else if (VAR_TYPES.has(cur.type)) {
      const parent = cur.parent;
      if (parent && parent.type === "export_statement") {
        const name = declaratorName(cur);
        if (name) return name;
      }
    } else if (cur.type === "program") {
      return null;
    }
    cur = cur.parent;
  }
  return null;
}

/**
 * Вызовы по именам (best-effort): callee — идентификатор либо свойство
 * member-вызова, совпадающее с символом ТОГО ЖЕ файла; на пару (caller, callee)
 * — одно ребро (первый вызов в порядке документа).
 */
function collectCalls(root: Node, symbols: ReadonlySet<string>): CallDecl[] {
  const out: CallDecl[] = [];
  const seen = new Set<string>();
  for (const call of root.descendantsOfType(["call_expression"])) {
    const fn = call.childForFieldName("function");
    if (!fn) continue;
    let callee: string | null = null;
    if (fn.type === "identifier") callee = fn.text;
    else if (fn.type === "member_expression") {
      const prop = fn.childForFieldName("property");
      if (prop && prop.type === "identifier") callee = prop.text;
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

/** Обход файлов → дельта: только symbol/calls (R6), coverage честный. */
async function buildDelta(root: string, files: string[]): Promise<GraphDelta> {
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  const edgeKeys = new Set<string>();
  const unsupported: string[] = [];
  const parsers = new Map<GrammarId, Parser>();
  try {
    let processed = 0;
    for (const rel of files) {
      // Кооперативная пауза (ТЗ рев.2 п.1): чтение + парс синхронные, каждые
      // 8 файлов отдаём ход event loop — соседние запросы не ждут весь прогон.
      if (++processed % 8 === 0) await new Promise<void>((resolve) => setImmediate(resolve));
      const grammar = EXT_GRAMMAR[extname(rel)];
      if (!grammar) continue;
      let parser = parsers.get(grammar);
      if (!parser) {
        parser = await parserFor(grammar);
        parsers.set(grammar, parser);
      }
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
        const symbols = collectSymbols(rootNode);
        const names = new Set(symbols.map((s) => s.name));
        for (const s of symbols) {
          nodes.push({
            id: symbolId(rel, s.name),
            kind: "symbol",
            path: rel,
            name: s.name,
            source: TSJS_ADAPTER_ID,
          });
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
    for (const parser of parsers.values()) parser.delete();
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
 * Расширенный канал: 0 подходящих файлов → status "absent" (адаптер не
 * попадает в index.adapters/missing[]), битая грамматика → "not_available"
 * с hint, прочее → исключение наружу (runner даёт "error").
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

export const treeSitterTsjsAdapter: DetailedAdapter = {
  id: TSJS_ADAPTER_ID,
  get version(): string {
    return packageVersion() ?? "0.0.0";
  },
  license: "MIT",
  precision: "syntax",
  priority: 50,
  detect(ctx: ScanContext): Promise<Capability[]> {
    const files = listSourceFiles(ctx.root, EXTS);
    return Promise.resolve(
      files.length > 0 ? [{ id: TSJS_ADAPTER_ID, confidence: "syntax", detail: `${files.length} files` }] : [],
    );
  },
  async *scan(ctx: ScanContext): AsyncIterable<GraphDelta> {
    const run = await outcome(ctx);
    if (run.status === "ok") yield* run.deltas;
  },
  outcome,
};
