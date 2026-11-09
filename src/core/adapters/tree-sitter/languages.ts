// T2b: таблица универсальных языков ТЗ рев.3 §7 — 9 языков, все MIT.
// Один источник правды: wasm-файл (канал grammars/), расширения, узлы
// символов, правила импортов и эвристика резолва. Формат — чистые данные;
// разбор выполняет generic.ts. Проверено живой загрузкой Language.load
// (разведка запись 6003): ABI и пути к wasm соответствуют таблице.
import type { GrammarId } from "./init.ts";

/** Правило извлечения импорта: узлы + совпадение (группа 1 — цель). */
export interface ImportRule {
  /** Типы узлов-источников: descendantsOfType по корню файла. */
  nodes: string[];
  /** Совпадение с текстом узла: группа 1 — цель импорта; без совпадения — пропуск. */
  match: RegExp;
}

export interface LanguageSpec {
  /** Язык грамматики: файл grammars/tree-sitter-<grammar>.wasm. */
  grammar: GrammarId;
  /** id адаптера (tree-sitter-<id>). */
  adapterId: string;
  /** Расширения файлов языка (включая служебные: .h, .hpp, .kts). */
  exts: string[];
  /** Основное расширение: резолв <name>.<ext>. */
  primaryExt: string;
  /** Разделители пути в цели импорта, заменяются на "/". */
  separators: string[];
  /** Правила импортов (несколько — например PHP: use + require/include). */
  imports: ImportRule[];
  /** Типы узлов символов (best-effort извлечение имени). */
  symbols: string[];
}

export const LANGUAGES: readonly LanguageSpec[] = [
  {
    grammar: "go",
    adapterId: "tree-sitter-go",
    exts: [".go"],
    primaryExt: ".go",
    separators: [],
    imports: [{ nodes: ["import_spec"], match: /"([^"]+)"/ }],
    symbols: ["function_declaration", "method_declaration", "type_spec"],
  },
  {
    grammar: "rust",
    adapterId: "tree-sitter-rust",
    exts: [".rs"],
    primaryExt: ".rs",
    separators: ["::"],
    imports: [
      { nodes: ["use_declaration"], match: /^\s*use\s+(?:crate\s*::\s*|self\s*::\s*|super\s*::\s*)?([\w:]+)/ },
    ],
    symbols: ["function_item", "struct_item", "enum_item", "mod_item", "trait_item"],
  },
  {
    grammar: "java",
    adapterId: "tree-sitter-java",
    exts: [".java"],
    primaryExt: ".java",
    separators: ["."],
    imports: [{ nodes: ["import_declaration"], match: /^\s*import\s+(?:static\s+)?([\w.]+)/ }],
    symbols: [
      "class_declaration",
      "interface_declaration",
      "enum_declaration",
      "method_declaration",
      "constructor_declaration",
    ],
  },
  {
    grammar: "kotlin",
    adapterId: "tree-sitter-kotlin",
    exts: [".kt", ".kts"],
    primaryExt: ".kt",
    separators: ["."],
    imports: [{ nodes: ["import_header"], match: /^\s*import\s+([\w.]+)/ }],
    symbols: ["class_declaration", "object_declaration", "function_declaration"],
  },
  {
    grammar: "csharp",
    adapterId: "tree-sitter-csharp",
    exts: [".cs"],
    primaryExt: ".cs",
    separators: ["."],
    imports: [{ nodes: ["using_directive"], match: /^\s*using\s+(?:static\s+)?([\w.]+)/ }],
    symbols: [
      "class_declaration",
      "interface_declaration",
      "struct_declaration",
      "enum_declaration",
      "method_declaration",
    ],
  },
  {
    grammar: "php",
    adapterId: "tree-sitter-php",
    exts: [".php"],
    primaryExt: ".php",
    separators: ["\\"],
    imports: [
      { nodes: ["namespace_use_declaration"], match: /^\s*use\s+(?:function\s+|const\s+)?([\w\\]+)/ },
      {
        nodes: ["require_expression", "require_once_expression", "include_expression", "include_once_expression"],
        match: /(?:require|include)(?:_once)?\s*\(?\s*['"]([^'"]+)['"]/,
      },
    ],
    symbols: ["function_definition", "class_declaration", "method_declaration"],
  },
  {
    grammar: "ruby",
    adapterId: "tree-sitter-ruby",
    exts: [".rb"],
    primaryExt: ".rb",
    separators: [],
    imports: [{ nodes: ["call"], match: /^\s*require(?:_relative)?\s*\(?\s*['"]([^'"]+)['"]/ }],
    symbols: ["method", "class", "module"],
  },
  {
    grammar: "c",
    adapterId: "tree-sitter-c",
    exts: [".c", ".h"],
    primaryExt: ".c",
    separators: [],
    imports: [{ nodes: ["preproc_include"], match: /^\s*#\s*include\s+"([^"]+)"/ }],
    symbols: ["function_definition", "struct_specifier", "enum_specifier"],
  },
  {
    grammar: "cpp",
    adapterId: "tree-sitter-cpp",
    exts: [".cpp", ".cc", ".cxx", ".hpp", ".hh", ".hxx"],
    primaryExt: ".cpp",
    separators: [],
    imports: [{ nodes: ["preproc_include"], match: /^\s*#\s*include\s+"([^"]+)"/ }],
    symbols: ["function_definition", "class_specifier", "struct_specifier", "namespace_definition"],
  },
];

/** Расширения всех языков таблицы (для резолва и обхода). */
export function allExts(): Set<string> {
  const out = new Set<string>();
  for (const spec of LANGUAGES) for (const ext of spec.exts) out.add(ext);
  return out;
}
