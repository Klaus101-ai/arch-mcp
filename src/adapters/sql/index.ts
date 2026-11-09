// T3: SQL-адаптер (ТЗ рев.3 §7; решения R10-R13).
//
// R13: без режима sqlglot DDL разбирает собственный PostgreSQL-лексер
// (CREATE TABLE: колонки/PK/FK; CREATE [OR REPLACE] VIEW: SELECT ... FROM/JOIN
// для lineage), DML — node-sql-parser@5.4.0 (Apache-2.0, SPDX адаптера).
// Режим ARCH_MCP_SQLGLOT=1 (+ARCH_MCP_ALLOW_EXEC=1): CTAS, CREATE MATERIALIZED
// VIEW, ALTER ... ADD CONSTRAINT FK и lineage-колонки дополнительно даёт
// python-мост python/sqlglot_bridge.py (sqlglot 30.29.0, MIT); Docker
// по-прежнему не применяется.
// R10: id узлов `table:<schema>.<name>` / `view:<schema>.<name>` — как в источнике,
// без смены регистра; неполное имя → schema "public" (search_path PostgreSQL).
// path — repo-relative POSIX.
// R11: вью → таблица `reads` (confidence syntax, file/line), FK — `references`
// с meta.fk=true, DML (insert/update/delete/merge) — `writes`, если разбирается
// node-sql-parser. Неразобранный оператор → файл в coverage.unsupported — без
// исключения, адаптер при этом не падает.
// R12: module/imports не порождаются — legacy-счётчики graph.modules/edge_count
// не меняются. Файлов нет → status "absent" (не в index.adapters/missing[]).
// T3.1 (вердикт T3): файл с чужим диалектом (MySQL/T-SQL: backticks, [dbo].[x],
// ENGINE=, AUTO_INCREMENT, NVARCHAR, GO и т.п.) → coverage.unsupported без узлов/рёбер
// вместо фантомного разбора как PostgreSQL (см. DIALECT_MARKERS).
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Parser as SqlParser } from "node-sql-parser";
import { packageVersion } from "../../cache.ts";
import { resolveSqlglotBridge, sqlglotModeOn } from "../../config.ts";
import { runExternal } from "../../core/exec.ts";
import type { AdapterOutcome, DetailedAdapter } from "../../core/adapters/runner.ts";
import { listSourceFiles, sortDelta } from "../../core/adapters/tree-sitter/init.ts";
import type {
  Capability,
  EdgeKind,
  GraphDelta,
  GraphEdge,
  GraphNode,
  NodeKind,
  ScanContext,
} from "../../core/adapters/types.ts";

// Режим sqlglot (ТЗ arch-mcp-sqlglot-20261105): ARCH_MCP_SQLGLOT=1 и
// ARCH_MCP_ALLOW_EXEC=1 → DDL/DML дополнительно разбирает python-мост
// python/sqlglot_bridge.py (sqlglot 30.29.0, MIT); без режима — прежний
// лексер + node-sql-parser, поведение не меняется.
/** Ожидаемая версия sqlglot: расхождение → evidence.version_mismatch, парс продолжается. */
const EXPECTED_SQLGLOT_VERSION = "30.29.0";
/** Виды рёбер, которые умеет отдавать мост. */
const BRIDGE_EDGE_KINDS = new Set(["reads", "writes", "references"]);
let bridgeRequestSeq = 0;

interface BridgeNode {
  id: string;
  kind: string;
  meta?: Record<string, unknown>;
}
interface BridgeEdge {
  source: string;
  target: string;
  kind: string;
  line?: number;
  meta?: Record<string, unknown>;
}
interface BridgeFile {
  path: string;
  nodes: BridgeNode[];
  edges: BridgeEdge[];
  errors: string[];
}
interface BridgePayload {
  ok: boolean;
  version: string;
  files: BridgeFile[];
  errors: string[];
}
type BridgeRun =
  | { ok: true; version: string; files: BridgeFile[]; command: string; stdout: string; stderr: string }
  | { ok: false; reason: string; command: string; stdout: string; stderr: string; exitCode: number | null };

export const SQL_ADAPTER_ID = "sql";

const SQL_EXTS = new Set([".sql"]);
const DEFAULT_SCHEMA = "public";
const sqlParser = new SqlParser();

const CREATE_TABLE_RE = /^\s*create\s+(?:(?:global|local)\s+)?(?:(?:temporary|temp|unlogged)\s+)*table\b/i;
const CREATE_VIEW_RE = /^\s*create\s+(?:or\s+replace\s+)?view\b/i;
const DML_RE = /^\s*(insert|update|delete|merge)\b/i;

/** Операторы, которые лексер сознательно не разбирает (вклада в граф не дают). */
const KNOWN_FIRST = new Set([
  "alter", "drop", "grant", "revoke", "comment", "set", "reset", "do", "begin", "commit",
  "rollback", "savepoint", "release", "analyze", "vacuum", "reindex", "refresh", "lock",
  "copy", "select", "with", "values", "call", "execute", "prepare", "deallocate", "explain",
  "show", "discard", "listen", "notify", "checkpoint", "cluster", "fetch", "move", "close",
  "unlisten", "truncate", "security",
]);
/** CREATE <второе слово>: операторы, которые лексер пропускает без разбора. */
const KNOWN_CREATE_SECOND = new Set([
  "schema", "index", "unique", "extension", "sequence", "type", "function", "procedure",
  "trigger", "role", "policy", "database", "aggregate", "operator", "collation", "language",
  "text", "statistics", "access", "server", "publication", "subscription", "event", "rule",
  "domain", "convert", "foreign",
]);

// T3.1 (вердикт T3, [MAJOR]): маркеры чужих диалектов — файл с MySQL/T-SQL-синтаксисом
// разбирать как PostgreSQL нельзя: NAME_TOKEN даёт фантомные узлы (table:public.schema_b)
// и self-FK (db_x→db_x). Совпадение любого маркера → файл в coverage.unsupported
// без извлечения узлов/рёбер. Проверяется маскированный текст (комментарии/строки
// уже вырезаны), чтобы не срабатывать на литералы. PostgreSQL-файлы (svs-trans)
// ни одному маркеру не соответствуют.
const DIALECT_MARKERS: RegExp[] = [
  /`[^`\n]+`/, // backtick-идентификаторы MySQL (`customers`)
  /\[\w+\]\s*\.\s*\[\w+\]/, // квалифицированные [...] T-SQL ([dbo].[custs])
  /\b(?:table|from|into|join|update|references|values)\s+\[\w+\]/i, // T-SQL после ключевого слова
  /\bENGINE\s*=/i, // ENGINE=InnoDB — MySQL
  /\bAUTO_INCREMENT\b/i, // MySQL
  /\bnvarchar\s*\(/i, // NVARCHAR(…) — T-SQL
  /^\s*GO\s*$/im, // GO — разделитель батчей T-SQL
  /\bIDENTITY\s*\(\s*\d+\s*,/, // IDENTITY(1,1) — T-SQL
  /\bGETDATE\s*\(/i, // GETDATE() — T-SQL
  /(?:DEFAULT\s+)?CHARSET\s*=/i, // CHARSET=utf8mb4 — MySQL
  /\bON\s+UPDATE\s+CURRENT_TIMESTAMP\b/i, // MySQL
];

/** Чужой диалект (MySQL/T-SQL/…): такой файл не парсим как PostgreSQL. */
function isForeignDialect(masked: string): boolean {
  return DIALECT_MARKERS.some((re) => re.test(masked));
}

interface Stmt {
  /** Исходный текст оператора (для node-sql-parser). */
  orig: string;
  /** Текст без комментариев/строк (для классификации и DDL-лексера). */
  struct: string;
  /** Абсолютное смещение начала в маске файла. */
  start: number;
  /** Строка первого значимего символа (1-based). */
  line: number;
}

interface Ctx {
  rel: string;
  start: number;
  lineAt: (offset: number) => number;
}

interface PendingEdge {
  kind: "reads" | "writes" | "references";
  source: string;
  target: string;
  line: number;
  fk: boolean;
}

interface FileParse {
  nodes: GraphNode[];
  edges: PendingEdge[];
  ok: boolean;
}

/** Маска файла: комментарии, одинарные строки и dollar-quoted блоки → пробелы (переносы строк сохраняются). */
function mask(text: string): string {
  const out = text.split("");
  const blank = (i: number): void => {
    if (out[i] !== "\n") out[i] = " ";
  };
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === "-" && text[i + 1] === "-") {
      while (i < text.length && text[i] !== "\n") {
        blank(i);
        i++;
      }
      continue;
    }
    if (c === "/" && text[i + 1] === "*") {
      blank(i);
      blank(i + 1);
      i += 2;
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) {
        blank(i);
        i++;
      }
      if (i < text.length) {
        blank(i);
        blank(i + 1);
        i += 2;
      }
      continue;
    }
    if (c === "'") {
      blank(i);
      i++;
      while (i < text.length) {
        if (text[i] === "'") {
          if (text[i + 1] === "'") {
            blank(i);
            blank(i + 1);
            i += 2;
            continue;
          }
          blank(i);
          i++;
          break;
        }
        if (text[i] === "\n") {
          i++; // перенос строки внутри строки SQL сохраняем
          continue;
        }
        blank(i);
        i++;
      }
      continue;
    }
    if (c === '"') {
      i++; // идентифициатор в кавычках копируем как есть
      while (i < text.length) {
        if (text[i] === '"') {
          if (text[i + 1] === '"') {
            i += 2;
            continue;
          }
          i++;
          break;
        }
        i++;
      }
      continue;
    }
    if (c === "$") {
      const m = /^\$[A-Za-z_0-9]*\$/.exec(text.slice(i, i + 64));
      if (m) {
        const tag = m[0];
        const end = text.indexOf(tag, i + tag.length);
        if (end === -1) {
          for (let j = i; j < i + tag.length; j++) blank(j); // незакрытый тег — маскируем только тег
          i += tag.length;
        } else {
          const stop = end + tag.length;
          for (let j = i; j < stop; j++) blank(j);
          i = stop;
        }
        continue;
      }
    }
    i++;
  }
  return out.join("");
}

/** Операторы маскированного текста: `;` на нулевой глубине скобок, вне кавычек. */
function splitStatements(masked: string): Array<{ start: number; end: number }> {
  const out: Array<{ start: number; end: number }> = [];
  let depth = 0;
  let inDq = false;
  let start = 0;
  for (let i = 0; i < masked.length; i++) {
    const c = masked[i];
    if (c === '"') {
      if (inDq && masked[i + 1] === '"') {
        i++;
        continue;
      }
      inDq = !inDq;
      continue;
    }
    if (inDq) continue;
    if (c === "(") depth++;
    else if (c === ")") {
      if (depth > 0) depth--;
    } else if (c === ";" && depth <= 0) {
      out.push({ start, end: i + 1 });
      start = i + 1;
    }
  }
  if (masked.slice(start).trim() !== "") out.push({ start, end: masked.length });
  return out;
}

function makeLineAt(text: string): (offset: number) => number {
  const starts: number[] = [0];
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) starts.push(i + 1);
  return (offset: number): number => {
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid] <= offset) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  };
}

function unquote(token: string): string {
  return token.length >= 2 && token.startsWith('"') && token.endsWith('"') ? token.slice(1, -1) : token;
}

const NAME_TOKEN = /"[^"]+"|[\w$]+/;

/** Имя `schema.name` (или неполное name) из позиции from. */
function parseQualified(
  s: string,
  from: number,
): { schema: string | null; name: string; end: number } | null {
  const rest = s.slice(from);
  const m = NAME_TOKEN.exec(rest);
  if (!m) return null;
  let schema: string | null = null;
  let name = unquote(m[0]);
  let consumed = m[0].length;
  const dot = /^\s*\.\s*/.exec(rest.slice(consumed));
  if (dot) {
    const m2 = NAME_TOKEN.exec(rest.slice(consumed + dot[0].length));
    if (m2) {
      schema = name;
      name = unquote(m2[0]);
      consumed += dot[0].length + m2[0].length;
    }
  }
  return { schema, name, end: from + consumed };
}

function tableId(schema: string | null, name: string): string {
  return `table:${schema ?? DEFAULT_SCHEMA}.${name}`;
}

const CREATE_MATERIALIZED_VIEW_RE = /^\s*create\s+(?:or\s+replace\s+)?materialized\s+view\b/i;

/** CTAS: после имени таблицы нет списка колонок — идёт AS <запрос> (режим sqlglot). */
function isCtasBody(s: string): boolean {
  const head =
    /^\s*create\s+(?:(?:global|local)\s+)?(?:(?:temporary|temp|unlogged)\s+)*table\s+(?:if\s+not\s+exists\s+)?/i.exec(s);
  if (!head) return false;
  const q = parseQualified(s, head[0].length);
  if (!q) return false;
  return !/^\s*\(/.test(s.slice(q.end));
}

/** Индекс парной скобки open (учёт кавычек) либо -1. */
function matchParen(s: string, open: number): number {
  let depth = 0;
  let inDq = false;
  for (let i = open; i < s.length; i++) {
    const c = s[i];
    if (c === '"') {
      if (inDq && s[i + 1] === '"') {
        i++;
        continue;
      }
      inDq = !inDq;
      continue;
    }
    if (inDq) continue;
    if (c === "(") depth++;
    else if (c === ")") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** Разрезка тела CREATE TABLE по запятым на нулевой глубине, со смещениями. */
function splitTopLevel(s: string): Array<{ text: string; offset: number }> {
  const out: Array<{ text: string; offset: number }> = [];
  let depth = 0;
  let inDq = false;
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '"') {
      if (inDq && s[i + 1] === '"') {
        i++;
        continue;
      }
      inDq = !inDq;
      continue;
    }
    if (inDq) continue;
    if (c === "(") depth++;
    else if (c === ")") {
      if (depth > 0) depth--;
    } else if (c === "," && depth === 0) {
      out.push({ text: s.slice(start, i), offset: start });
      start = i + 1;
    }
  }
  if (s.slice(start).trim() !== "") out.push({ text: s.slice(start), offset: start });
  return out;
}

const CONSTRAINT_ITEM_RE = /^(?:constraint\s+[\w$]+\s+|primary\s+key\s+|foreign\s+key\s+|unique\s+|check\s+|exclude\s+|like\s+)/i;
const PK_ITEM_RE = /^(?:constraint\s+[\w$]+\s+)?primary\s+key\b/i;

/** CREATE TABLE: узел table + references-рёбра FK. null — не разобралось. */
function parseCreateTable(stmt: Stmt, ctx: Ctx): FileParse | null {
  const s = stmt.struct;
  const head =
    /^\s*create\s+(?:(?:global|local)\s+)?(?:(?:temporary|temp|unlogged)\s+)*table\s+(?:if\s+not\s+exists\s+)?/i.exec(s);
  if (!head) return null;
  const q = parseQualified(s, head[0].length);
  if (!q) return null;
  const open = s.indexOf("(", q.end);
  if (open < 0) return null;
  const close = matchParen(s, open);
  if (close < 0) return null;
  const body = s.slice(open + 1, close);
  const id = tableId(q.schema, q.name);
  const columns: string[] = [];
  const primaryKey: string[] = [];
  const fks: Array<{ target: string; line: number }> = [];
  for (const item of splitTopLevel(body)) {
    const text = item.text.trim();
    if (text === "") continue;
    const ref = /\breferences\s+/i.exec(item.text);
    if (ref) {
      const target = parseQualified(item.text, ref.index + ref[0].length);
      if (target) {
        const abs = ctx.start + open + 1 + item.offset + ref.index;
        fks.push({ target: tableId(target.schema, target.name), line: ctx.lineAt(abs) });
      }
    }
    if (PK_ITEM_RE.test(text)) {
      const cols = /\(([^)]*)\)/.exec(text);
      if (cols) {
        for (const col of cols[1].split(",")) {
          const name = unquote(col.trim());
          if (name !== "" && !primaryKey.includes(name)) primaryKey.push(name);
        }
      }
    }
    if (!CONSTRAINT_ITEM_RE.test(text)) {
      const first = NAME_TOKEN.exec(text);
      if (first) columns.push(unquote(first[0]));
    }
  }
  const nodes: GraphNode[] = [
    {
      id,
      kind: "table",
      path: ctx.rel,
      name: q.name,
      source: SQL_ADAPTER_ID,
      meta: { schema: q.schema ?? DEFAULT_SCHEMA, columns, primary_key: primaryKey },
    },
  ];
  const edges: PendingEdge[] = fks.map((fk) => ({
    kind: "references",
    source: id,
    target: fk.target,
    line: fk.line,
    fk: true,
  }));
  return { nodes, edges, ok: true };
}

/** Имя CTE из ведущей WITH-клаузы (их FROM-цели — не таблицы). */
function collectCtes(s: string): Set<string> {
  const ctes = new Set<string>();
  const head = /^\s*with\s+(?:recursive\s+)?/i.exec(s);
  if (!head) return ctes;
  let pos = head[0].length;
  for (;;) {
    const m = /^\s*("[^"]+"|[\w$]+)\s+as\s*\(/i.exec(s.slice(pos));
    if (!m) break;
    ctes.add(unquote(m[1]).toLowerCase());
    const open = pos + m[0].length - 1;
    const close = matchParen(s, open);
    if (close < 0) break;
    pos = close + 1;
    const comma = /^\s*,/.exec(s.slice(pos));
    if (!comma) break;
    pos += comma[0].length;
  }
  return ctes;
}

/** Цели FROM/JOIN на любом уровне вложенности (подзапросы — читаются таблицы). */
function collectFromTables(
  s: string,
  ctes: Set<string>,
  ctx: Ctx,
  base: number,
): Array<{ id: string; line: number }> {
  const out: Array<{ id: string; line: number }> = [];
  const re = /\b(?:from|join)\s+/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s)) !== null) {
    let pos = m.index + m[0].length;
    const kw = /^\s*(?:only|lateral)\s+/i.exec(s.slice(pos));
    if (kw) pos += kw[0].length;
    for (;;) {
      const q = parseQualified(s, pos);
      if (!q) break;
      re.lastIndex = q.end;
      const isCte = q.schema === null && ctes.has(q.name.toLowerCase());
      if (!isCte) out.push({ id: tableId(q.schema, q.name), line: ctx.lineAt(ctx.start + base + m.index) });
      const comma = /^\s*,/.exec(s.slice(q.end));
      if (!comma) break;
      pos = q.end + comma[0].length;
    }
  }
  return out;
}

/** CREATE [OR REPLACE] VIEW: узел view + reads-рёбра lineage. null — не разобралось. */
function parseCreateView(stmt: Stmt, ctx: Ctx): FileParse | null {
  const s = stmt.struct;
  const head = /^\s*create\s+(?:or\s+replace\s+)?view\s+(?:if\s+not\s+exists\s+)?/i.exec(s);
  if (!head) return null;
  const q = parseQualified(s, head[0].length);
  if (!q) return null;
  const asMatch = /\bas\b/i.exec(s.slice(q.end));
  if (!asMatch) return null;
  const bodyStart = q.end + asMatch.index + asMatch[0].length;
  const body = s.slice(bodyStart);
  const ctes = collectCtes(body);
  const id = `view:${q.schema ?? DEFAULT_SCHEMA}.${q.name}`;
  const nodes: GraphNode[] = [
    { id, kind: "view", path: ctx.rel, name: q.name, source: SQL_ADAPTER_ID, meta: { schema: q.schema ?? DEFAULT_SCHEMA } },
  ];
  const edges: PendingEdge[] = collectFromTables(body, ctes, ctx, bodyStart).map((t) => ({
    kind: "reads",
    source: id,
    target: t.id,
    line: t.line,
    fk: false,
  }));
  return { nodes, edges, ok: true };
}

/** DML → writes-рёбра через node-sql-parser. null — парсер не разобрал. */
function parseDml(stmt: Stmt, ctx: Ctx): FileParse | null {
  const targets: string[] = [];
  let list: string[];
  try {
    list = sqlParser.tableList(stmt.orig, { database: "postgresql" });
  } catch {
    return null;
  }
  for (const entry of list) {
    const parts = entry.split("::");
    if (parts.length !== 3) continue;
    const [verb, schema, name] = parts;
    if (!/^(?:insert|update|delete|merge)$/.test(verb)) continue;
    if (name === "" || name === undefined) continue;
    targets.push(tableId(schema === "null" || schema === "" ? null : schema, name));
  }
  const edges: PendingEdge[] = targets.map((target) => ({
    kind: "writes",
    source: ctx.rel,
    target,
    line: stmt.line,
    fk: false,
  }));
  return { nodes: [], edges, ok: true };
}

function isKnownStatement(struct: string): boolean {
  const m = /^\s*([a-z_]+)(?:\s+([a-z_]+))?/i.exec(struct);
  if (!m) return false;
  const w1 = m[1].toLowerCase();
  if (w1 === "create") return KNOWN_CREATE_SECOND.has((m[2] ?? "").toLowerCase());
  return KNOWN_FIRST.has(w1);
}

function parseStatement(stmt: Stmt, ctx: Ctx, modeOn: boolean): FileParse | null {
  const s = stmt.struct;
  // Режим sqlglot: CTAS и CREATE MATERIALIZED VIEW разбирает мост — старый
  // лексер пропускает их без unsupported и без фантомных узлов.
  if (modeOn && CREATE_MATERIALIZED_VIEW_RE.test(s)) return { nodes: [], edges: [], ok: true };
  if (modeOn && CREATE_TABLE_RE.test(s) && isCtasBody(s)) return { nodes: [], edges: [], ok: true };
  if (CREATE_TABLE_RE.test(s)) return parseCreateTable(stmt, ctx);
  if (CREATE_VIEW_RE.test(s)) return parseCreateView(stmt, ctx);
  if (DML_RE.test(s)) return parseDml(stmt, ctx);
  if (isKnownStatement(s)) return { nodes: [], edges: [], ok: true };
  return null;
}

/** Разбор одного SQL-файла: узлы/рёбра + признак «есть неразобранный оператор». */
function parseFile(root: string, rel: string, modeOn: boolean): FileParse {
  let text: string;
  try {
    text = readFileSync(join(root, rel), "utf8");
  } catch {
    return { nodes: [], edges: [], ok: false };
  }
  const masked = mask(text);
  // T3.1: чужой диалект (MySQL/T-SQL) → файл в coverage.unsupported без узлов/рёбер.
  if (isForeignDialect(masked)) return { nodes: [], edges: [], ok: false };
  const lineAt = makeLineAt(masked);
  const nodes: GraphNode[] = [];
  const edges: PendingEdge[] = [];
  let ok = true;
  for (const seg of splitStatements(masked)) {
    const struct = masked.slice(seg.start, seg.end);
    const first = struct.search(/\S/);
    const ctx: Ctx = { rel, start: seg.start, lineAt };
    const stmt: Stmt = {
      orig: text.slice(seg.start, seg.end),
      struct,
      start: seg.start,
      line: lineAt(seg.start + Math.max(first, 0)),
    };
    const parsed = parseStatement(stmt, ctx, modeOn);
    if (parsed === null) {
      ok = false;
      continue;
    }
    nodes.push(...parsed.nodes);
    edges.push(...parsed.edges);
  }
  return { nodes, edges, ok };
}

/** Узел из результата моста: path/name/source заполняет адаптер. */
function bridgeNode(n: BridgeNode, rel: string): GraphNode {
  const kind: NodeKind = n.kind === "view" ? "view" : "table";
  const node: GraphNode = {
    id: n.id,
    kind,
    path: rel,
    name: n.id.slice(n.id.lastIndexOf(".") + 1),
    source: SQL_ADAPTER_ID,
  };
  if (n.meta && Object.keys(n.meta).length > 0) node.meta = { ...n.meta };
  return node;
}

async function buildDelta(
  root: string,
  files: string[],
  bridge?: { files: BridgeFile[] } | null,
  modeOn = false,
): Promise<GraphDelta> {
  const fileNodes: GraphNode[] = [];
  const defined = new Map<string, GraphNode>();
  const edges: GraphEdge[] = [];
  const edgeKeys = new Set<string>();
  const edgeByKey = new Map<string, GraphEdge>();
  const referenced = new Map<string, { file: string; line: number }>();
  const unsupported = new Set<string>();
  const legacyOk = new Map<string, boolean>();

  for (const rel of files) {
    const parsed = parseFile(root, rel, modeOn);
    legacyOk.set(rel, parsed.ok);
    if (!parsed.ok) unsupported.add(rel);
    fileNodes.push({
      id: rel,
      kind: "file",
      path: rel,
      name: rel.slice(rel.lastIndexOf("/") + 1),
      source: SQL_ADAPTER_ID,
    });
    for (const node of parsed.nodes) if (!defined.has(node.id)) defined.set(node.id, node);
    for (const e of parsed.edges) {
      const key = `${e.kind}|${e.source}|${e.target}`;
      if (edgeKeys.has(key)) continue;
      edgeKeys.add(key);
      if (!defined.has(e.target) && !referenced.has(e.target)) {
        referenced.set(e.target, { file: rel, line: e.line });
      }
      const edge: GraphEdge = {
        source: e.source,
        target: e.target,
        kind: e.kind,
        file: rel,
        line: e.line,
        confidence: "syntax",
        meta: e.fk ? { fk: true, dependencyTypes: [e.kind] } : { dependencyTypes: [e.kind] },
      };
      edgeByKey.set(key, edge);
      edges.push(edge);
    }
  }

  // Режим sqlglot: вклад моста только по файлам, разобранным лексером —
  // чужой диалект и битый SQL уже в unsupported, их результат игнорируется
  // (unsupported при этом остаётся ровно один раз, без дублей).
  if (bridge) {
    const byPath = new Map(bridge.files.map((f) => [f.path, f]));
    // Сначала реальные узлы (first-wins: заглушка реальный узел не перетирает),
    // затем заглушки — только на ещё не занятые id.
    for (const stubPass of [false, true]) {
      for (const rel of files) {
        if (!legacyOk.get(rel)) continue;
        const bf = byPath.get(rel);
        if (!bf) continue;
        for (const n of bf.nodes) {
          if ((n.meta?.stub === true) !== stubPass || defined.has(n.id)) continue;
          defined.set(n.id, bridgeNode(n, rel));
        }
      }
    }
    for (const rel of files) {
      if (!legacyOk.get(rel)) continue;
      const bf = byPath.get(rel);
      if (!bf) continue;
      for (const e of bf.edges) {
        if (!BRIDGE_EDGE_KINDS.has(e.kind)) continue;
        const key = `${e.kind}|${e.source}|${e.target}`;
        const existing = edgeByKey.get(key);
        if (existing) {
          // Существующее ребро дополняется только meta.columns: fk/via и
          // прочая мета источника не перетирается (inline FK остаётся inline).
          const cols = e.meta?.columns;
          if (Array.isArray(cols) && cols.length > 0 && !Array.isArray(existing.meta?.columns)) {
            existing.meta = { ...existing.meta, columns: cols };
          }
          continue;
        }
        edgeKeys.add(key);
        if (!defined.has(e.target) && !referenced.has(e.target)) {
          referenced.set(e.target, { file: rel, line: e.line ?? 1 });
        }
        const edge: GraphEdge = {
          source: e.source,
          target: e.target,
          kind: e.kind as EdgeKind,
          file: rel,
          line: e.line ?? 1,
          confidence: "syntax",
          meta: { ...(e.meta ?? {}), dependencyTypes: [e.kind] },
        };
        edgeByKey.set(key, edge);
        edges.push(edge);
      }
    }
  }

  // Таблицы, на которые ссылаются, но нигде не объявлены: узел-заглушка, не дыра в ребре.
  for (const [id, ref] of referenced) {
    if (defined.has(id)) continue;
    defined.set(id, {
      id,
      kind: "table",
      path: ref.file,
      name: id.slice(id.lastIndexOf(".") + 1),
      source: SQL_ADAPTER_ID,
      meta: { inferred: true },
    });
  }

  const sorted = sortDelta([...fileNodes, ...defined.values()], edges);
  return {
    nodes: sorted.nodes,
    edges: sorted.edges,
    coverage: {
      files_seen: files.length,
      parsed: files.length - unsupported.size,
      unsupported: [...unsupported].sort(),
    },
  };
}

/** Запуск python-моста: запрос пишется в ctx.cacheDir и удаляется в finally. */
async function runBridge(ctx: ScanContext, files: string[]): Promise<BridgeRun> {
  const env = process.env;
  const python = (env.ARCH_MCP_PYTHON ?? "").trim() || "python";
  const bridgePath = resolveSqlglotBridge(env);
  const command = `${python} ${bridgePath} <request.json> ${ctx.root}`;
  const fail = (reason: string, res?: { stdout: string; stderr: string; exitCode: number | null }): BridgeRun => ({
    ok: false,
    reason,
    command,
    stdout: res?.stdout ?? "",
    stderr: res?.stderr ?? "",
    exitCode: res?.exitCode ?? null,
  });
  if (!ctx.cacheDir) return fail("sqlglot bridge: cacheDir пуст — запрос некуда положить");
  const request = { bridge: 1, dialect: "postgres", files: files.map((path) => ({ path })) };
  const requestFile = join(ctx.cacheDir, `sqlglot-${process.pid}-${Date.now()}-${bridgeRequestSeq++}.json`);
  try {
    mkdirSync(ctx.cacheDir, { recursive: true });
    writeFileSync(requestFile, JSON.stringify(request), "utf8");
  } catch (err) {
    return fail(`sqlglot bridge: cannot write request: ${String(err)}`);
  }
  try {
    const res = await runExternal(python, [bridgePath, requestFile, ctx.root], { timeoutMs: ctx.timeoutMs });
    if (res.spawnError) return fail(`sqlglot bridge: python не запускается: ${res.stderr.slice(0, 300)}`, res);
    if (res.timedOut) return fail(`sqlglot bridge: таймаут ${ctx.timeoutMs} ms`, res);
    if (res.exitCode !== 0) return fail(`sqlglot bridge: exit ${res.exitCode}: ${res.stderr.slice(0, 300)}`, res);
    let parsed: unknown;
    try {
      parsed = JSON.parse(res.stdout);
    } catch {
      return fail("sqlglot bridge: stdout не JSON", res);
    }
    const out = parsed as Partial<BridgePayload>;
    if (!out || out.ok !== true) {
      const detail = Array.isArray(out?.errors) ? out.errors.join("; ").slice(0, 300) : "";
      return fail(`sqlglot bridge: ok=false${detail ? `: ${detail}` : ""}`, res);
    }
    if (typeof out.version !== "string" || !Array.isArray(out.files)) {
      return fail("sqlglot bridge: битый payload (нет version/files)", res);
    }
    return { ok: true, version: out.version, files: out.files, command, stdout: res.stdout, stderr: res.stderr };
  } finally {
    try {
      rmSync(requestFile, { force: true });
    } catch {
      /* файла могло не быть — не мешаем работе */
    }
  }
}

async function outcome(ctx: ScanContext): Promise<AdapterOutcome> {
  const files = listSourceFiles(ctx.root, SQL_EXTS);
  if (files.length === 0) return { status: "absent", deltas: [] };
  // Режим sqlglot: строго ARCH_MCP_SQLGLOT=1 && ARCH_MCP_ALLOW_EXEC=1.
  if (!sqlglotModeOn()) return { status: "ok", deltas: [await buildDelta(ctx.root, files)] };
  const bridge = await runBridge(ctx, files);
  if (!bridge.ok) {
    // Деградация (ТЗ): граф строится прежним лексером (режим off, дельты прежние),
    // статус not_available, причина в evidence.
    return {
      status: "not_available",
      evidence: {
        command: bridge.command,
        exit_code: bridge.exitCode,
        stdout: bridge.stdout.slice(0, 2000),
        stderr: bridge.stderr.slice(0, 2000),
        stdout_bytes: bridge.stdout.length,
        reason: bridge.reason,
      },
      deltas: [await buildDelta(ctx.root, files, null, false)],
    };
  }
  // Парс продолжается и при расхождении версии: mismatch фиксируется в evidence.
  const mismatch = bridge.version !== EXPECTED_SQLGLOT_VERSION;
  const evidence: Record<string, unknown> = {
    command: bridge.command,
    exit_code: 0,
    stdout: bridge.stdout.slice(0, 2000),
    stderr: bridge.stderr.slice(0, 2000),
    stdout_bytes: bridge.stdout.length,
    sqlglot_version: bridge.version,
    version_mismatch: mismatch,
  };
  if (mismatch) evidence.reason = `sqlglot ${bridge.version} != ${EXPECTED_SQLGLOT_VERSION}`;
  return { status: "ok", evidence, deltas: [await buildDelta(ctx.root, files, bridge, true)] };
}

/** T3: адаптер SQL — DDL-лексер + node-sql-parser (ТЗ рев.3 §7). */
export const sqlAdapter: DetailedAdapter = {
  id: SQL_ADAPTER_ID,
  get version(): string {
    return packageVersion() ?? "0.0.0";
  },
  license: "Apache-2.0",
  precision: "syntax",
  priority: 50,
  detect(ctx: ScanContext): Promise<Capability[]> {
    const files = listSourceFiles(ctx.root, SQL_EXTS);
    return Promise.resolve(
      files.length > 0 ? [{ id: SQL_ADAPTER_ID, confidence: "syntax", detail: `${files.length} files` }] : [],
    );
  },
  async *scan(ctx: ScanContext): AsyncIterable<GraphDelta> {
    const run = await outcome(ctx);
    if (run.status === "ok") yield* run.deltas;
  },
  outcome,
};
