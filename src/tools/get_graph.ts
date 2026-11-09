import { readFileSync } from "node:fs";
import {
  buildCacheKey,
  collectMtimes,
  collectWorkspaceSignature,
  packageVersion,
  readCache,
  repoCacheDir,
  sha256Hex,
  writeCache,
  type CacheKeyInput,
} from "../cache.ts";
import { depcruiseConfigPlan, toolchainVersion, type DepcruiseEvidence } from "../adapters/depcruiser.ts";
import { inspectGit, type GitInfo } from "../adapters/git.ts";
import type { ArchMcpConfig } from "../config.ts";
import { mergeDeltas } from "../core/adapters/merge.ts";
import { adapterSignature, listAdapters } from "../core/adapters/registry.ts";
import { runAdapter, type AdapterRun } from "../core/adapters/runner.ts";
import type { EdgeKind } from "../core/adapters/types.ts";
import type { KindStat } from "../core/envelope.ts";
import type { ScanContext } from "../core/adapters/types.ts";

// T5.1: типы вынесены в core/adapters/types-graph.ts (убран импорт-цикл с
// core/adapters/depcruiser-adapter.ts); реэкспорт сохраняет API dist/lib.mjs
// и существующие тесты/импорты (queries.ts, core/diff.ts, core/snapshots.ts).
import type { GraphEdge, NormalizedGraph } from "../core/adapters/types-graph.ts";
export type { GraphEdge, NormalizedGraph } from "../core/adapters/types-graph.ts";

// T1.2b: нормализация depcruiser перенесена в обёртку адаптера
// (core/adapters/depcruiser-adapter.ts) — ядро больше не знает raw-формат.
// Реэкспорт сохраняет API dist/lib.mjs и существующие тесты.
export { extractCircles, moduleCount, normalizeDepcruiser } from "../core/adapters/depcruiser-adapter.ts";

/**
 * Обрезка payload по ARCH_MCP_MAX_RESPONSE_BYTES: сначала ужимается evidence,
 * затем урезаются nodes/edges до попадания в бюджет. truncated ставится только
 * когда что-то реально усечено; в пределах бюджета payload не меняется.
 * При обрезке всегда добавляется hint (ТЗ рев.3, п.4).
 */
export const HINT_BUDGET = "truncated by ARCH_MCP_MAX_RESPONSE_BYTES — raise max_bytes";

export function enforceBudget<T extends { nodes?: string[]; edges?: GraphEdge[]; evidence?: DepcruiseEvidence }>(
  payload: T,
  maxBytes: number,
): T & { truncated: boolean; hint?: string } {
  const out: T = { ...payload };
  const fitsRaw = (): boolean => Buffer.byteLength(JSON.stringify(out), "utf8") <= maxBytes;
  const fits = (candidate?: { nodes?: string[]; edges?: GraphEdge[] }): boolean =>
    Buffer.byteLength(JSON.stringify({ ...out, ...candidate, truncated: true, hint: HINT_BUDGET }), "utf8") <= maxBytes;

  if (fitsRaw()) return { ...out, truncated: false };

  if (out.evidence) {
    const ev: DepcruiseEvidence = { ...out.evidence };
    for (const field of ["stdout", "stderr"] as const) {
      if (ev[field].length > 2000) ev[field] = ev[field].slice(0, 2000) + "\n…[truncated]";
    }
    out.evidence = ev;
    if (fits()) return { ...out, truncated: true, hint: HINT_BUDGET };
  }

  if (out.nodes && out.edges) {
    const allEdges: GraphEdge[] = payload.edges!;
    // При подгонке nodes считаются как endpoints оставшихся рёбер: полный список узлов
    // сам по себе может не влезать в бюджет и обнулять поиск.
    const probe = (n: number): { nodes: string[]; edges: GraphEdge[] } => {
      const slice = allEdges.slice(0, n);
      const nodes = [...new Set(slice.flatMap((e) => [e.source, e.target]))].sort();
      return { nodes, edges: slice };
    };
    let hi = allEdges.length;
    let lo = 0;
    let best = 0;
    while (lo <= hi) {
      const mid = Math.floor((lo + hi) / 2);
      if (fits(probe(mid))) {
        best = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    out.edges = allEdges.slice(0, best);
    out.nodes = best === allEdges.length ? out.nodes : probe(best).nodes;
  }
  return { ...out, truncated: true, hint: HINT_BUDGET };
}

export interface GraphPayload {
  nodes: string[];
  edges: GraphEdge[];
  repo: string;
  evidence: DepcruiseEvidence;
  toolchain: { status: string; version: string | null };
  truncated: boolean;
  hint?: string;
  cached: boolean;
}

export function configHashes(cfg: ArchMcpConfig): Record<string, string> {
  return {
    stacks: sha256Hex(cfg.stacks),
    maxResponseBytes: sha256Hex(String(cfg.maxResponseBytes)),
    timeoutMs: sha256Hex(String(cfg.timeoutMs)),
    // Режим sqlglot входит в ключ: вкл/выкл, другой python и правка файла
    // моста дают другой ключ — кэш режимов не смешивается (ТЗ sqlglot).
    sqlglotMode: sha256Hex(cfg.sqlglotMode ? "on" : "off"),
    sqlglotPython: sha256Hex(cfg.sqlglotPython),
    sqlglotBridge: sha256Hex(bridgeContent(cfg.sqlglotBridge)),
    // ТЗ scip-indexer, п.2.7: режим индексера (on/off) и сам шаблон входят в
    // ключ — режим 0/1 при одном шаблоне и разные шаблоны дают разные ключи.
    scipIndexerMode: sha256Hex(cfg.scipIndexerOn ? "on" : "off"),
    scipIndexer: sha256Hex(cfg.scipIndexer),
  };
}

/** Содержимое эффективного файла моста; файла нет → маркер "missing" (хэш считает вызывающий). */
function bridgeContent(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "missing";
  }
}

export function cacheKeyInput(
  repoGit: { gitHead: string | null; status: string[] },
  repo: string,
  cfg: ArchMcpConfig,
  workspaceSignature?: string,
): CacheKeyInput {
  return {
    head: repoGit.gitHead,
    mtimes: collectMtimes(repo, repoGit.status),
    toolchainVersion: toolchainVersion(),
    configHashes: configHashes(cfg),
    packageVersion: packageVersion(),
    // Режим парсера берётся из того же plan, который использует depcruiser-адаптер:
    // ключ кэша детерминированно соответствует фактическому прогону.
    parser: depcruiseConfigPlan().mode,
    // R4: подпись состава зарегистрированных адаптеров — смена состава/версии
    // адаптера меняет ключ и инвалидирует кэш.
    adapterSignature: adapterSignature(),
    // ТЗ рев.2 п.4: подпись (path, mtimeMs, size) передаётся только для не-git
    // (head === null); для git поле опущено → ключ канала git не меняется.
    ...(workspaceSignature !== undefined ? { workspaceSignature } : {}),
  };
}

export function cacheKeyFor(input: CacheKeyInput): string {
  return buildCacheKey(input);
}

export function cacheRead(repo: string, key: string): unknown | null {
  return readCache(repoCacheDir(repo), key);
}

export function cacheWrite(repo: string, key: string, value: unknown): void {
  writeCache(repoCacheDir(repo), key, value);
}

/** Результат слияния дельт всех зарегистрированных адаптеров (mergeDeltas). */
export type MergedDelta = ReturnType<typeof mergeDeltas>;

/**
 * T1.2b: кэш-запись — слияние дельт адаптеров вместо raw-ответа depcruiser:
 * узлы/рёбра с meta.adapters, coverage и contributors; evidence внешнего
 * инструмента — для ответа и ошибок. Форма закреплена GRAPH_SCHEMA_VERSION=graph-8.
 * ТЗ v3, п.B: + фактические статусы адаптеров прогона (источник index.adapters
 * при кэш-хите) и + degraded{reason,ts} — маркер деградации core.
 */
export interface GraphCacheEntry {
  merged: MergedDelta;
  evidence: DepcruiseEvidence;
  exitCode: number | null;
  /** ТЗ v3, п.B: статусы всех адаптеров прогона — читаются при кэш-хите. */
  adapterStatuses: Array<{ name: string; status: string; version: string | null; reason?: string }>;
  /** ТЗ v3, п.B: деградация core (depcruiser ≠ ok/absent); сбой git — не деградация. */
  degraded?: { reason: string; ts: string };
}

/**
 * TTL деградации core в кэше (ТЗ v3, п.B): запись с degraded отдаётся из кэша,
 * пока (now − ts) ≤ TTL; после TTL — кэш-промах и пересбор. Вне TTL деградация
 * не кэшируется вечно: инструмент получает шанс восстановиться.
 */
export const DEGRADED_TTL_MS = 15 * 60 * 1000;

/** Полный граф из кэша/прогона — БЕЗ бюджета: общий источник get_graph и query-инструментов. */
export interface FullGraph {
  graph: NormalizedGraph;
  evidence: DepcruiseEvidence;
  cached: boolean;
  status: string;
  /** Число модулей (coverage.files_seen). */
  filesSeen: number;
  /**
   * T2a: разобранные позиции (coverage.parsed), максимум по адаптерам.
   * Раньше считался как graph.nodes.length; symbol-узлы tree-sitter в этот
   * счётчик не входят (R6b) — иначе coverage уезжает (226/226 → 226/N).
   */
  parsedFiles: number;
  /** Неразобранные позиции нормализации (coverage.unsupported). */
  unsupported: string[];
  /** Циклы depcruiser (рёбра с meta.circular). */
  circular: Array<{ source: string; target: string }>;
  /**
   * R6b: число module-узлов и imports-рёбер — то, что считают legacy-счётчики
   * graph.modules/graph.edge_count в arch_status/arch_snapshot. Новые виды
   * (symbol/calls) в эти числа не входят.
   */
  moduleNodes: number;
  importsEdges: number;
  /** Статусы всех зарегистрированных адаптеров — источник index.adapters. */
  adapters: Array<{ name: string; status: string; version: string | null; reason?: string }>;
  /** Адаптеры, отдавшие дельту в слияние (mergeDeltas.contributors). */
  contributors: string[];
  /** P01: счётчики видов рёбер merged для index.kinds (ТЗ рев.6, п.1). */
  kindStats: KindStat[];
}

/** Проекция слияния адаптеров в NormalizedGraph ядра: nodes=id, type=join(dependencyTypes). */
function projectMerged(merged: MergedDelta): NormalizedGraph {
  return {
    nodes: merged.nodes.map((n) => n.id),
    edges: merged.edges.map((e) => {
      const types = e.meta?.dependencyTypes;
      const type = Array.isArray(types) && types.length > 0 ? (types as unknown[]).join(",") : "unknown";
      // Дельта рев.8: из merged-ребра переносится только lineage-columns
      // (sqlglot) и type_only; остальная meta (adapters и пр.) в ядро не идёт.
      const meta: GraphEdge["meta"] = { type_only: e.meta?.type_only === true };
      const cols = e.meta?.columns;
      if (Array.isArray(cols) && cols.length > 0) meta.columns = cols as Array<{ from: string; to: string }>;
      return { source: e.source, target: e.target, type, meta };
    }),
  };
}

/**
 * P01: счётчики видов рёбер merged для index.kinds (ТЗ рев.6, п.1).
 * Эмиттеры вида — объединение meta.adapters рёбер (mergeDeltas пишет туда
 * адаптеры, чьи рёбра вошли в слияние), отсортировано.
 */
function kindStatsOf(merged: MergedDelta): KindStat[] {
  const byKind = new Map<EdgeKind, { edges: number; adapters: Set<string> }>();
  for (const e of merged.edges) {
    let slot = byKind.get(e.kind);
    if (!slot) {
      slot = { edges: 0, adapters: new Set() };
      byKind.set(e.kind, slot);
    }
    slot.edges += 1;
    const meta = e.meta?.adapters;
    if (Array.isArray(meta)) {
      for (const id of meta) if (typeof id === "string") slot.adapters.add(id);
    }
  }
  return [...byKind.entries()].map(([kind, slot]) => ({
    kind,
    edges: slot.edges,
    emitters: [...slot.adapters].sort(),
  }));
}

/** Циклы из слияния: рёбра с meta.circular, пары без дублей. */
function circularOf(merged: MergedDelta): Array<{ source: string; target: string }> {
  const seen = new Set<string>();
  const out: Array<{ source: string; target: string }> = [];
  for (const e of merged.edges) {
    if (e.meta?.circular !== true) continue;
    const pair = `${e.source}\u0000${e.target}`;
    if (seen.has(pair)) continue;
    seen.add(pair);
    out.push({ source: e.source, target: e.target });
  }
  return out;
}

const SYNTHETIC_EVIDENCE: DepcruiseEvidence = { command: "", exit_code: null, stdout: "", stderr: "", stdout_bytes: 0 };

/** Кооперативная пауза: отдаёт ход event loop, чтобы параллельные запросы
 * обрабатывались во время построения графа (ТЗ рев.2 п.1). */
const yieldToEventLoop = (): Promise<void> => new Promise<void>((resolve) => setImmediate(resolve));

/**
 * Single-flight (ТЗ рев.2 п.2): один прогон построения на workspace+ключ кэша.
 * Второй одновременный вызов с тем же ключом ждёт ТОТ ЖЕ результат (тот же
 * FullGraph), адапторы второй раз не запускаются. Ключ включает cacheKey
 * (HEAD/подпись файлов, конфиг, состав адаптеров) — разные ключи = разные прогоны.
 */
const IN_FLIGHT = new Map<string, Promise<FullGraph>>();

/**
 * Держатель прогонов (ТЗ v3, п.A): тот же flightKey, что и IN_FLIGHT, плюс
 * прогресс done/total для building-ответа arch_status и lastError прогона
 * (не всплывает наружу — наблюдаемость для fire-and-forget прогона).
 */
export interface BuildRun {
  promise: Promise<FullGraph>;
  /** Сколько адаптеров уже отработало (инкремент после runAdapter). */
  done: number;
  /** Всего адаптеров в прогоне (adapters.length). */
  total: number;
  /** Ошибка прогона, если он отвергся; для диагностики arch_status. */
  lastError?: string;
}

const RUNS = new Map<string, BuildRun>();

/** Подготовка прогона: git (или переданный вызывающим), подпись, ключ, flightKey. */
async function prepareBuild(
  repo: string,
  cfg: ArchMcpConfig,
  git?: GitInfo,
): Promise<{ git: GitInfo; adapters: ReturnType<typeof listAdapters>; useCache: boolean; key: string; flightKey: string }> {
  const info = git ?? (await inspectGit(repo, cfg.timeoutMs));
  const adapters = listAdapters();
  const isGit = info.gitHead !== null;
  const signature = isGit ? undefined : ((await collectWorkspaceSignature(repo)) ?? undefined);
  const useCache = isGit || signature !== undefined;
  const key = cacheKeyFor(cacheKeyInput(info, repo, cfg, signature));
  return { git: info, adapters, useCache, key, flightKey: `${repoCacheDir(repo)}|${key}` };
}

/**
 * Свежая кэш-запись (ТЗ v3, п.B): промах — записи нет либо деградация
 * протухла ((now − ts) > DEGRADED_TTL_MS) → пересбор. Запись без degraded
 * отдаётся всегда; семантику ключа см. README, «Заметки».
 */
function freshHit(repo: string, key: string, useCache: boolean): GraphCacheEntry | null {
  if (!useCache) return null;
  const hit = cacheRead(repo, key) as GraphCacheEntry | null;
  if (!hit || !hit.merged) return null;
  if (hit.degraded !== undefined) {
    const ts = Date.parse(hit.degraded.ts);
    if (Number.isNaN(ts) || Date.now() - ts > DEGRADED_TTL_MS) return null;
  }
  return hit;
}

/**
 * Граф-статус (ТЗ v3, п.C): только core {git, depcruiser}. На живом прогоне
 * primary — первый core-адаптер с evidence среди встроенных (git граф не даёт,
 * R3; у прочих встроенных нет канала outcome), на кэш-хите — статус depcruiser
 * из записи. Evidence опциональных адаптеров граф-уровневым не становится.
 */
/**
 * ТЗ v6, п.2.2: состав core-адаптеров граф-статуса/evidence — только git и
 * depcruiser. Константа, а не builtinAdapters(): builtin-адаптер с evidence
 * (scip/sql при деградации) перехватывал FullGraph.status/evidence.
 */
export const CORE_ADAPTER_IDS: readonly string[] = ["git", "depcruiser"];

function coreStatusOf(statuses: Array<{ name: string; status: string }>): string {
  return statuses.find((s) => s.name === "depcruiser")?.status ?? "ok";
}

/** FullGraph из кэш-записи: статусы адаптеров и статус графа — из записи (ТЗ п.B). */
function fullFromCache(hit: GraphCacheEntry, adapters: ReturnType<typeof listAdapters>): FullGraph {
  const merged = hit.merged;
  const evidence = { ...hit.evidence, command: `${hit.evidence.command} (cached)` };
  const statuses = hit.adapterStatuses ?? adapters.map((a) => ({ name: a.id, status: "ok", version: a.version }));
  return {
    graph: projectMerged(merged),
    evidence,
    cached: true,
    status: coreStatusOf(statuses),
    filesSeen: merged.coverage.files_seen,
    parsedFiles: merged.coverage.parsed,
    unsupported: merged.coverage.unsupported ?? [],
    circular: circularOf(merged),
    moduleNodes: merged.nodes.filter((n) => n.kind === "module").length,
    importsEdges: merged.edges.filter((e) => e.kind === "imports").length,
    adapters: statuses,
    contributors: merged.contributors,
    kindStats: kindStatsOf(merged),
  };
}

/** Старт прогона: запись в оба держателя, снятие ключа в finally промиса. */
function startBuild(
  repo: string,
  cfg: ArchMcpConfig,
  p: { git: GitInfo; adapters: ReturnType<typeof listAdapters>; useCache: boolean; key: string; flightKey: string },
): BuildRun {
  const run: BuildRun = { promise: null as unknown as Promise<FullGraph>, done: 0, total: p.adapters.length };
  const promise = buildFullGraph(repo, cfg, p.git, p.adapters, p.useCache, p.key, run);
  run.promise = promise;
  IN_FLIGHT.set(p.flightKey, promise);
  RUNS.set(p.flightKey, run);
  // Ключ снимается в finally промиса (перенос try/finally loadFullGraph сюда):
  // иначе fire-and-forget-прогоны arch_status оставили бы держатель навсегда.
  promise
    .finally(() => {
      IN_FLIGHT.delete(p.flightKey);
      RUNS.delete(p.flightKey);
    })
    .catch((err: unknown) => {
      run.lastError = err instanceof Error ? err.message : String(err);
    });
  return run;
}

/**
 * Граф через реестр адаптеров (T1.2b): runAdapter для каждого зарегистрированного
 * адаптера (без исключений наружу), слияние через mergeDeltas, проекция в
 * NormalizedGraph. Граф-статус/evidence даёт core-адаптер с outcome-каналом
 * (depcruiser) — фильтр по встроенным (ТЗ v3, п.C). Кэш по ключу с
 * adapterSignature (R4): hit → merged из кэша (статусы и статус графа — из
 * записи, ТЗ п.B); miss → прогоны + запись при любом исходе, кроме кэш-off
 * (ТЗ п.B). Бюджет ARCH_MCP_MAX_RESPONSE_BYTES здесь НЕ применяется — он
 * только на ответ. ТЗ рев.2 п.4: без git HEAD (не-git каталог) ключ строится
 * по подписи файлов workspace (path, mtimeMs, size; исключены только
 * node_modules и .git). Одновременные одинаковые вызовы сводятся в один
 * прогон (single-flight). git — необязательный параметр: вызывающий
 * (server_core) инспектирует репозиторий один раз и передаёт результат
 * (ТЗ v3, п.D — убран двойной inspectGit).
 */
export async function loadFullGraph(repo: string, cfg: ArchMcpConfig, git?: GitInfo): Promise<FullGraph> {
  const p = await prepareBuild(repo, cfg, git);
  const pending = IN_FLIGHT.get(p.flightKey);
  if (pending) return pending;
  return startBuild(repo, cfg, p).promise;
}

/** Результат пробы arch_status (ТЗ v3, п.A). */
export type ArchStatusProbe =
  | { kind: "ready"; full: FullGraph }
  | { kind: "building"; done: number; total: number; percent: number; lastError?: string };

function buildingOf(run: BuildRun): ArchStatusProbe {
  const percent = run.total > 0 ? Math.round((run.done / run.total) * 100) : 0;
  const base = { kind: "building" as const, done: run.done, total: run.total, percent };
  return run.lastError === undefined ? base : { ...base, lastError: run.lastError };
}

/**
 * arch_status не ждёт сборку (ТЗ v3, п.A):
 * (i) свежий кэш-хит → ready с графом из записи;
 * (ii) прогон идёт → building с прогрессом done/total;
 * (iii) прогона нет → fire-and-forget ensureBuild (промис в IN_FLIGHT/RUNS,
 * ошибка → lastError, наружу не всплывает) + немедленный building (percent 0).
 * Остальные инструменты строгие: они ждут существующий промис (single-flight).
 */
export async function archStatusProbe(repo: string, cfg: ArchMcpConfig, git?: GitInfo): Promise<ArchStatusProbe> {
  const p = await prepareBuild(repo, cfg, git);
  const hit = freshHit(repo, p.key, p.useCache);
  if (hit !== null) return { kind: "ready", full: fullFromCache(hit, p.adapters) };
  const running = RUNS.get(p.flightKey);
  if (running !== undefined) return buildingOf(running);
  return buildingOf(startBuild(repo, cfg, p));
}

/** Тело прогона: обход адаптеров → слияние → (кэш). Вызывается только из single-flight. */
async function buildFullGraph(
  repo: string,
  cfg: ArchMcpConfig,
  git: GitInfo,
  adapters: ReturnType<typeof listAdapters>,
  useCache: boolean,
  key: string,
  run: BuildRun,
): Promise<FullGraph> {
  const ctx: ScanContext = {
    root: repo,
    roots: [repo],
    gitHead: git.gitHead,
    files: [],
    // Факт доступности git ядро уже знает из inspectGit (R3: git граф не даёт).
    capabilities: git.available ? [{ id: "git", confidence: "manifest" }] : [],
    cacheDir: repoCacheDir(repo),
    timeoutMs: cfg.timeoutMs,
    maxBytes: cfg.maxResponseBytes,
    // ТЗ v6, п.2.1: конфиг прогона в ctx — адаптеры (scip) читают только его.
    config: cfg,
  };

  // Кэш-ветка (ТЗ v3, п.B): статусы адаптеров и статус графа берутся из
  // записи; протухшая деградация сюда не попадает — freshHit вернул null.
  const hit = freshHit(repo, key, useCache);
  if (hit !== null) return fullFromCache(hit, adapters);

  const runs: AdapterRun[] = [];
  for (const adapter of adapters) {
    // Кооперативная пауза между адаптерами (ТЗ рев.2 п.1): sync-обход файлов
    // (listSourceFiles, init.ts:174-197) внутри адаптера блокирует ход не
    // дольше одного обхода, а пауза между адаптерами отдаёт event loop целиком.
    await yieldToEventLoop();
    runs.push(await runAdapter(adapter, ctx));
    // Прогресс прогона для building-ответа arch_status (ТЗ v3, п.A).
    run.done += 1;
  }
  // Граф-статус и его evidence — только core {git, depcruiser} (ТЗ v3, п.C):
  // первый core-адаптер с evidence среди встроенных; evidence опциональных
  // адаптеров граф-уровневым не становится. ТЗ v6, п.2.2: состав core —
  // константа CORE_ADAPTER_IDS, а не builtinAdapters(): иначе builtin-адаптер
  // с evidence (scip/sql при деградации) перехватывает статус/evidence графа.
  const coreIds = new Set(CORE_ADAPTER_IDS);
  const primary = runs.find((r) => coreIds.has(r.adapter.id) && r.evidence !== undefined);
  const status = primary?.status ?? "not_available";
  const evidence = (primary?.evidence as DepcruiseEvidence | undefined) ?? SYNTHETIC_EVIDENCE;
  // Кооперативная пауза перед CPU-слиянием (ТЗ п.1): mergeDeltas синхронный.
  await yieldToEventLoop();
  const merged = mergeDeltas(runs.flatMap((r) => r.deltas.map((delta) => ({ adapter: r.adapter, delta }))));
  const adapterStatuses = runs.map((r) => ({
    name: r.adapter.id,
    status: r.status,
    version: r.adapter.version,
    // ТЗ v6, п.2.5: причина не-ok статуса (scip-индексер) доходит до
    // index.adapters[].reason и в живом прогоне, и из кэш-записи.
    ...(r.reason !== undefined ? { reason: r.reason } : {}),
  }));
  // Запись при любом исходе, кроме кэш-off (не-git без подписи) — ТЗ v3, п.B:
  // прежнее условие «только все ok/absent» отменено; деградация core
  // (depcruiser ≠ ok/absent) кэшируется с degraded{reason,ts} на TTL.
  if (useCache) {
    const dep = adapterStatuses.find((s) => s.name === "depcruiser");
    const degraded =
      dep !== undefined && dep.status !== "ok" && dep.status !== "absent"
        ? { reason: dep.status, ts: new Date().toISOString() }
        : undefined;
    cacheWrite(
      repo,
      key,
      {
        merged,
        evidence,
        exitCode: 0,
        adapterStatuses,
        ...(degraded !== undefined ? { degraded } : {}),
      } satisfies GraphCacheEntry,
    );
  }

  return {
    graph: projectMerged(merged),
    evidence,
    // Прогон всегда без кэша: кэш-ветка возвращается выше через fullFromCache.
    cached: false,
    status,
    filesSeen: merged.coverage.files_seen,
    parsedFiles: merged.coverage.parsed,
    unsupported: merged.coverage.unsupported ?? [],
    circular: circularOf(merged),
    moduleNodes: merged.nodes.filter((n) => n.kind === "module").length,
    importsEdges: merged.edges.filter((e) => e.kind === "imports").length,
    adapters: adapterStatuses,
    contributors: merged.contributors,
    kindStats: kindStatsOf(merged),
  };
}

/**
 * Дельта рев.8: публичный граф без lineage-колонок — рёбра сводятся к
 * meta:{type_only}, nodes без изменений. columns остаётся только в focus.
 * Применяется: graphSection публичного ответа, сохраняемый снимок (server_core)
 * и обёртка getGraph (публичный реэкспорт lib.mjs).
 */
export function stripColumnMeta(graph: NormalizedGraph): NormalizedGraph {
  return {
    nodes: graph.nodes,
    edges: graph.edges.map((e) => ({
      source: e.source,
      target: e.target,
      type: e.type,
      meta: { type_only: e.meta?.type_only === true },
    })),
  };
}

/** get_graph(repo): depcruiser JSON → {nodes, edges} + обрезка по бюджету. */
export async function getGraph(repo: string, cfg: ArchMcpConfig): Promise<GraphPayload> {
  const full = await loadFullGraph(repo, cfg);
  // Кооперативная пауза перед CPU-обрезкой (ТЗ п.1): enforceBudget синхронный
  // и делает несколько JSON.stringify за бинарный поиск.
  await yieldToEventLoop();
  const payload = enforceBudget(
    {
      ...stripColumnMeta(full.graph),
      repo,
      evidence: full.evidence,
      toolchain: { status: full.cached ? "ok (cached)" : full.status, version: toolchainVersion() },
    },
    cfg.maxResponseBytes,
  );
  return { ...payload, cached: full.cached };
}

export type { ArchMcpConfig };
