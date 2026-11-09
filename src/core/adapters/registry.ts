// T1.2a/T1.2b: реестр адаптеров (контракт ТЗ рев.3 §6).
// Импорт — только встроенные адаптеры (обёртки git/depcruiser) и типы:
// циклов нет, ни один адаптер не импортирует реестр, конверт или сервер.
import { depcruiserAdapter } from "./depcruiser-adapter.ts";
import { gitAdapter } from "./git-adapter.ts";
import { manifestsAdapter } from "../../adapters/manifests/index.ts";
import { sqlAdapter } from "../../adapters/sql/index.ts";
import { apiAdapter } from "../../adapters/api/index.ts";
import { dockerfileAdapter } from "../../adapters/infra/dockerfile.ts";
import { k8sAdapter } from "../../adapters/infra/k8s.ts";
import { ciAdapter } from "../../adapters/infra/ci.ts";
import { terraformAdapter } from "../../adapters/infra/terraform.ts";
import { docsAdapter } from "../../adapters/docs/index.ts";
import { treeSitterPythonAdapter } from "./tree-sitter/python.ts";
import { treeSitterLanguageAdapters } from "./tree-sitter/generic.ts";
import { scipAdapter } from "./tree-sitter/scip.ts";
import { treeSitterTsjsAdapter } from "./tree-sitter/tsjs.ts";
import type { Adapter, EdgeKind } from "./types.ts";

const adapters = new Map<string, Adapter>();
const builtinIds = new Set<string>();

export interface RegisterOptions {
  /** Встроенный адаптер (git/depcruiser) — участвует в builtinAdapters(). */
  builtin?: boolean;
}

/** Повторная регистрация того же id обновляет запись (идемпотентно). */
export function registerAdapter(adapter: Adapter, opts?: RegisterOptions): void {
  adapters.set(adapter.id, adapter);
  if (opts?.builtin) builtinIds.add(adapter.id);
}

/** Список в порядке: priority по убыванию, затем id лексикографически. */
export function listAdapters(): Adapter[] {
  return [...adapters.values()].sort((a, b) => {
    if (a.priority !== b.priority) return b.priority - a.priority;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

/** Встроенные адаптеры: git и depcruiser, зарегистрированные при загрузке модуля. */
export function builtinAdapters(): Adapter[] {
  return listAdapters().filter((a) => builtinIds.has(a.id));
}

/**
 * R4: каноническая подпись состава для ключа кэша — отсортированные
 * "id:version:priority" всех зарегистрированных адаптеров. Смена состава,
 * версии или приоритета адаптера меняет подпись → инвалидирует кэш.
 */
export function adapterSignature(list: Adapter[] = listAdapters()): string {
  return list.map((a) => `${a.id}:${a.version}:${a.priority}`).sort().join("|");
}

export function loadAdapterStatus(): Array<{ name: string; status: string; version: string | null }> {
  return listAdapters().map((a) => ({ name: a.id, status: "registered", version: a.version }));
}

// T1.2b: встроенные адаптеры регистрируются при загрузке модуля —
// listAdapters/builtinAdapters/индекс конверта сразу содержат git и depcruiser.
// T2a: tree-sitter (priority 50) — два адаптера: JS/TS (symbol/calls, R6)
// и Python (module/imports/calls); адаптер с нулём файлов отдаёт status "absent"
// и в index.adapters/missing[] не попадает (см. core/envelope.ts).
// T2b: +9 универсальных языков (generic.ts, таблица languages.ts) и SCIP
// (scip.ts, priority 200, precision semantic) — те же правила absent/not_available.
registerAdapter(gitAdapter, { builtin: true });
registerAdapter(depcruiserAdapter, { builtin: true });
// T3: SQL (DDL-лексер + node-sql-parser) и манифесты (ТЗ рев.3 §7): table/view/
// package-узлы и reads/references/writes-рёбра; module/imports не порождаются (R12),
// адаптер с нулём файлов отдаёт status "absent" (правило T2a).
registerAdapter(sqlAdapter, { builtin: true });
registerAdapter(manifestsAdapter, { builtin: true });
// T4a: API-адаптер (ТЗ рев.3 §7, R14-R17): OpenAPI/Swagger/proto/GraphQL/AsyncAPI,
// узлы api/service, priority 50, precision syntax; absent при нуле API-файлов.
registerAdapter(apiAdapter, { builtin: true });
// T4b: инфраструктура и документация (ТЗ рев.3 §7, R19-R23): Dockerfile,
// K8s-манифесты, CI-workflows, Terraform (только при ARCH_MCP_TERRAFORM=1,
// R22 — без флага absent, MPL-модуль лениво) и Markdown-документация;
// priority 50, precision syntax; module/imports не порождаются (R21).
registerAdapter(dockerfileAdapter, { builtin: true });
registerAdapter(k8sAdapter, { builtin: true });
registerAdapter(ciAdapter, { builtin: true });
registerAdapter(terraformAdapter, { builtin: true });
registerAdapter(docsAdapter, { builtin: true });
registerAdapter(treeSitterPythonAdapter, { builtin: true });
registerAdapter(treeSitterTsjsAdapter, { builtin: true });
for (const adapter of treeSitterLanguageAdapters) registerAdapter(adapter, { builtin: true });
registerAdapter(scipAdapter, { builtin: true });

/**
 * P01 (ТЗ рев.6, п.3): карта эмиттеров видов рёбер для index.kinds.
 * Ключи — все 10 видов EdgeKind строго в порядке объявления в types.ts;
 * значение — перечень адаптеров, способных эмитить вид (сверено с кодом:
 * depcruiser/generic/python → imports; tsjs/python → calls; sql → reads/writes;
 * sql/api/manifests/docs/ci/terraform/k8s/dockerfile/scip → references;
 * k8s → deploys; extends/implements/configures/tests никем не эмитятся → []).
 * git граф не даёт (R3) и в карту не входит. Используется блоком index.kinds
 * (core/envelope.ts): пустой перечень = статус not_emitted.
 */
export const KIND_EMITTERS: Record<EdgeKind, readonly string[]> = {
  imports: [
    "depcruiser",
    "tree-sitter-python",
    "tree-sitter-c",
    "tree-sitter-cpp",
    "tree-sitter-csharp",
    "tree-sitter-go",
    "tree-sitter-java",
    "tree-sitter-kotlin",
    "tree-sitter-php",
    "tree-sitter-ruby",
    "tree-sitter-rust",
  ],
  calls: ["tree-sitter-tsjs", "tree-sitter-python"],
  extends: [],
  implements: [],
  reads: ["sql"],
  writes: ["sql"],
  references: ["sql", "api", "manifests", "docs", "ci", "terraform", "k8s", "dockerfile", "scip"],
  configures: [],
  deploys: ["k8s"],
  tests: [],
};

/** Виды рёбер в каноническом порядке EdgeKind (ключи KIND_EMITTERS). */
export const EDGE_KINDS = Object.keys(KIND_EMITTERS) as EdgeKind[];
