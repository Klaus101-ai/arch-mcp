// Внутренности для юнит-тестов (dist/lib.mjs): без запуска сервера и транспорта.
export { loadConfig, scipIndexerOn, MAX_MAX_BYTES, type ArchMcpConfig, type StackFilter } from "./config.ts";
export {
  ArchMcpError,
  ERROR_CODES,
  isArchMcpError,
  toErrorEnvelope,
  type ErrorCode,
  type ErrorEnvelope,
} from "./core/errors.ts";
export {
  SCHEMA_VERSION,
  assertIndexBuilding,
  buildBuildingIndex,
  buildIndexBlock,
  resolveMaxBytes,
  successEnvelope,
  HINT_BUILDING,
  type EnvelopeProvenance,
  type IndexBlock,
  type IndexInput,
  type SuccessEnvelope,
} from "./core/envelope.ts";
export {
  DEFAULT_IGNORE,
  MANIFESTS,
  discoverRootFrom,
  isRootDir,
  resolveWorkspace,
  type WorkspaceOptions,
  type WorkspaceResolution,
} from "./core/workspace.ts";
export {
  loadSnapshotByHead,
  loadSnapshotById,
  resolveSnapshotRef,
  saveSnapshot,
  snapshotId,
  snapshotsDir,
  type RefContext,
  type SnapshotSide,
  type StoredSnapshot,
} from "./core/snapshots.ts";
export { diffSnapshots, type DiffEdge, type DiffPayload } from "./core/diff.ts";
export { buildProvenance, toJsonResult, type Provenance } from "./provenance.ts";
export {
  buildCacheKey,
  cacheRoot,
  collectMtimes,
  collectWorkspaceSignature,
  GRAPH_SCHEMA_VERSION,
  packageVersion,
  readCache,
  repoCacheDir,
  sha1Hex,
  sha256Hex,
  writeCache,
} from "./cache.ts";
export {
  EXCLUDED_TEST_DIRS,
  isTestFile,
  matchNode,
  normalizeNode,
  resolveInputPath,
  stripDotSegments,
  type NodeMatch,
  type RepoPathResult,
} from "./paths.ts";
export {
  inspectGit,
  inspectGitStats,
  normalizeStatusLines,
  parseLastCommit,
  resetInspectGitStats,
  runGit,
  type GitInfo,
} from "./adapters/git.ts";
export {
  depcruiseBin,
  packageRoot,
  readToolchainLock,
  runDepcruiser,
  toolchainDir,
  toolchainVersion,
  type DepcruiseResult,
} from "./adapters/depcruiser.ts";
export {
  cacheKeyFor,
  cacheKeyInput,
  configHashes,
  enforceBudget,
  extractCircles,
  getGraph,
  loadFullGraph,
  moduleCount,
  normalizeDepcruiser,
  stripColumnMeta,
  archStatusProbe,
  // ТЗ scip-indexer, п.2.2: core-состав граф-статуса/evidence (реэкспорт).
  CORE_ADAPTER_IDS,
  DEGRADED_TTL_MS,
  type ArchStatusProbe,
  type BuildRun,
  type FullGraph,
  type GraphEdge,
  type NormalizedGraph,
} from "./tools/get_graph.ts";
export {
  affectedTests,
  applyResponseBudget,
  DEFAULT_FOCUS_LIMIT,
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_DEPTH,
  filterTypeOnly,
  focus,
  impact,
  MAX_FOCUS_LIMIT,
  reaches,
  search,
  SEARCH_KINDS,
  type AffectedTestsPayload,
  type FocusPayload,
  type ImpactPayload,
  type ReachPayload,
  type SearchKind,
  type SearchMatch,
  type SearchPayload,
} from "./tools/queries.ts";
export { detectStacks, type StacksResult } from "./tools/stacks.ts";
export { archSnapshot, type SnapshotPayload } from "./tools/arch_snapshot.ts";
export {
  assertExecAllowed,
  externalTimeoutError,
  isExecAllowed,
  resetSpawnStats,
  runExternal,
  spawnStats,
  type ExecOptions,
  type ExecResult,
} from "./core/exec.ts";
export { runTool, toolResultToMcp, type ToolArgs, type ToolContext } from "./server_core.ts";
export {
  DEP_CRUISER_SPEC,
  LOCK_NAME,
  MARKER_NAME,
  bootstrap,
  listTmpDirs,
  runNpmInstall,
  sha256File,
  sweepInterrupted,
} from "./bootstrap.ts";
// T1.2a: SDK адаптеров графа (контракт ТЗ рев.3 §6).
// GraphEdge адаптеров реэкспортируется под алиасом: имя GraphEdge уже занят
// типом из ./tools/get_graph.ts (существующий экспорт не меняем).
export type {
  Adapter,
  Capability,
  EdgeKind,
  GraphDelta,
  GraphEdge as AdapterGraphEdge,
  GraphNode,
  NodeKind,
  Precision,
  ScanContext,
  WorkspaceContext,
} from "./core/adapters/types.ts";
export { mergeDeltas } from "./core/adapters/merge.ts";
export {
  adapterSignature,
  builtinAdapters,
  EDGE_KINDS,
  KIND_EMITTERS,
  listAdapters,
  loadAdapterStatus,
  registerAdapter,
} from "./core/adapters/registry.ts";
// T1.2b: обёртки адаптеров и раннер — ядро работает через реестр.
export { gitAdapter, GIT_ADAPTER_VERSION } from "./core/adapters/git-adapter.ts";
export { depcruiserAdapter, depcruiserDelta, depcruiserOutcome } from "./core/adapters/depcruiser-adapter.ts";
// T2a: пайплайн WASM tree-sitter — два языковых адаптера (ТЗ рев.3 §7/§6).
export { treeSitterPythonAdapter, PYTHON_ADAPTER_ID } from "./core/adapters/tree-sitter/python.ts";
export { treeSitterTsjsAdapter, TSJS_ADAPTER_ID } from "./core/adapters/tree-sitter/tsjs.ts";
// T2b: универсальные языки (9 адаптеров из таблицы) и SCIP (ТЗ рев.3 §7).
export { createLanguageAdapter, treeSitterLanguageAdapters } from "./core/adapters/tree-sitter/generic.ts";
export { LANGUAGES, type ImportRule, type LanguageSpec } from "./core/adapters/tree-sitter/languages.ts";
export { scipAdapter, scipFilePath, SCIP_ADAPTER_ID } from "./core/adapters/tree-sitter/scip.ts";
// ТЗ scip-indexer (v6, п.2.4): разбор шаблона, подстановка, запуск и уборка.
export {
  cleanupScipRunDir,
  launchScipIndexer,
  nextScipRunDir,
  parseScipIndexerTemplate,
  planScipIndexer,
  scipFailureReason,
  SCIP_EMPTY_COMMAND,
  SCIP_TIMEOUT_REASON,
  SCIP_UNTERMINATED_QUOTE,
  SCIP_UNSUPPORTED_SHELL,
  type ScipIndexerLaunch,
  type ScipIndexerPlan,
  type ScipTemplateParse,
} from "./core/adapters/tree-sitter/scip-indexer.ts";
// T3: SQL-адаптер (DDL-лексер + node-sql-parser) и адаптер манифестов (ТЗ рев.3 §7).
export { sqlAdapter, SQL_ADAPTER_ID } from "./adapters/sql/index.ts";
export { manifestsAdapter, MANIFESTS_ADAPTER_ID } from "./adapters/manifests/index.ts";
// T4a: API-адаптер (ТЗ рев.3 §7, R14-R17): OpenAPI/Swagger/proto/GraphQL/AsyncAPI.
export { apiAdapter, API_ADAPTER_ID } from "./adapters/api/index.ts";
// T4b: инфраструктура и документация (ТЗ рев.3 §7, R19-R23): Dockerfile, K8s,
// CI, Terraform (R22: только при ARCH_MCP_TERRAFORM=1, без флага absent) и docs.
export { dockerfileAdapter, DOCKERFILE_ADAPTER_ID } from "./adapters/infra/dockerfile.ts";
export { k8sAdapter, K8S_ADAPTER_ID } from "./adapters/infra/k8s.ts";
export { ciAdapter, CI_ADAPTER_ID } from "./adapters/infra/ci.ts";
export { terraformAdapter, TERRAFORM_ADAPTER_ID } from "./adapters/infra/terraform.ts";
export { docsAdapter, DOCS_ADAPTER_ID } from "./adapters/docs/index.ts";
export { runAdapter, type AdapterOutcome, type AdapterRun, type DetailedAdapter } from "./core/adapters/runner.ts";
export { adapterVersions } from "./core/snapshots.ts";
