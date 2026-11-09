// T5.1 (вердикт критика 6471-6477, MINOR 1): общий тип нормализованного
// графа вынесен из tools/get_graph.ts, чтобы core/adapters не импортировал
// tools (рантайм-цикл depcruiser-adapter → get_graph → registry →
// depcruiser-adapter). Файл — только типы, ни одного рантайм-импорта.
// Реэкспорт из tools/get_graph.ts сохраняет API dist/lib.mjs и тесты.
export interface GraphEdge {
  source: string;
  target: string;
  type: string;
  /**
   * Метаданные ребра: type_only — зависимость только типа (`import type`);
   * columns — lineage-пары {from,to} sqlglot-рёбер (дельта рев.8): остаётся
   * только в focus, из публичного графа/снимков снимается stripColumnMeta.
   */
  meta: { type_only: boolean; columns?: Array<{ from: string; to: string }> };
}

export interface NormalizedGraph {
  nodes: string[];
  edges: GraphEdge[];
  /** Файлы/зависимости, которые нормализация не разобрала (coverage.unsupported). */
  unsupported?: string[];
}
