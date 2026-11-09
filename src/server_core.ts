import { join } from "node:path";
import { inspectGit, type GitInfo } from "./adapters/git.ts";
import { packageRoot, toolchainVersion } from "./adapters/depcruiser.ts";
import { MARKER_NAME } from "./bootstrap.ts";
import { cacheRoot } from "./cache.ts";
import { loadConfig } from "./config.ts";
import { ArchMcpError } from "./core/errors.ts";
import {
  assertIndexBuilding,
  buildBuildingIndex,
  buildIndexBlock,
  resolveMaxBytes,
  successEnvelope,
  HINT_BUILDING,
  type IndexBlock,
  type SuccessEnvelope,
} from "./core/envelope.ts";
import { externalTimeoutError } from "./core/exec.ts";
import { diffSnapshots } from "./core/diff.ts";
import { adapterVersions, resolveSnapshotRef, saveSnapshot, snapshotId, type StoredSnapshot } from "./core/snapshots.ts";
import { resolveWorkspace, type WorkspaceResolution } from "./core/workspace.ts";
import { buildProvenance, toJsonResult, type ToolCallResult } from "./provenance.ts";
import { enforceBudget, loadFullGraph, stripColumnMeta, archStatusProbe, HINT_BUDGET, type FullGraph } from "./tools/get_graph.ts";
import { affectedTests, focus, impact, reaches, search } from "./tools/queries.ts";
import { detectStacks } from "./tools/stacks.ts";

export interface ToolContext {
  name: string;
  workspace: string;
  root_used: string;
  roots: string[];
  gitHead: string | null;
  exitCode: number | null;
  command: string;
  /** Полный конверт ответа (ТЗ рев.3, п.3). */
  payload: SuccessEnvelope;
  /** Машиночитаемая копия конверта для structuredContent MCP-ответа. */
  structuredContent: SuccessEnvelope;
  cached: boolean;
}

export interface ToolArgs {
  workspace?: string;
  /** Алиас workspace (до v1.1): при обоих полях побеждает workspace. */
  repo?: string;
  node?: string;
  target?: string;
  changed?: string[];
  query?: string;
  kind?: string;
  max_depth?: number;
  /** Алиас max_depth (до v1.1): при обоих полях побеждает max_depth. */
  maxDepth?: number;
  depth?: number;
  limit?: number;
  max_bytes?: number;
  include_type_only?: boolean;
  scope?: string;
  from?: string;
  to?: string;
}

function nonEmpty(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new ArchMcpError("INVALID_ARGUMENT", `${field} is required (absolute or repo-relative path)`, {
      hint: `${field}: non-empty string`,
    });
  }
  return value;
}

function optionalBool(value: unknown, field: string): boolean | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "boolean") {
    throw new ArchMcpError("INVALID_ARGUMENT", `${field} must be a boolean, got: ${JSON.stringify(value)}`, {
      hint: `${field}: true | false`,
    });
  }
  return value;
}

function normalizeScope(raw: unknown): "summary" | "full" {
  if (raw === undefined || raw === null || raw === "") return "summary";
  if (raw === "summary" || raw === "full") return raw;
  throw new ArchMcpError("INVALID_ARGUMENT", `scope must be summary|full, got: ${JSON.stringify(raw)}`, {
    hint: "scope: summary (default) | full",
  });
}

function gitPayload(git: GitInfo): Record<string, unknown> {
  return {
    is_repo: git.isRepo,
    git_head: git.gitHead,
    status_lines: git.status.length,
    last_commit: git.lastCommit,
  };
}

/**
 * Диспетчер восьми инструментов + переходные алиасы stacks/get_graph (до v1.1).
 * Ошибки контракта — ArchMcpError (9 кодов, см. core/errors.ts).
 */
export async function runTool(
  name: string,
  args: ToolArgs,
  opts: { env?: NodeJS.ProcessEnv; cwd?: string } = {},
): Promise<ToolContext> {
  const env = opts.env ?? process.env;
  const cwd = opts.cwd ?? process.cwd();
  const cfg = loadConfig(env);
  const maxBytes = resolveMaxBytes(args.max_bytes, cfg.maxResponseBytes);

  // repo — алиас workspace; при обоих полях побеждает workspace.
  const requested = nonEmpty(args.workspace) ?? nonEmpty(args.repo);
  const ws: WorkspaceResolution = resolveWorkspace(requested, { env, cwd });
  assertIndexBuilding(join(packageRoot(), MARKER_NAME));

  const root = ws.root_used;
  const git = await inspectGit(root, cfg.timeoutMs);

  /** Lenient-проверка ядра: таймаут depcruiser → EXTERNAL_TOOL_FAILED. */
  const assertLenient = (full: FullGraph): void => {
    if (full.status === "timeout") throw externalTimeoutError("depcruiser", cfg.timeoutMs);
  };
  const loadGraphLenient = async (): Promise<FullGraph> => {
    // git инспектируется один раз в runTool и передаётся дальше (ТЗ v3, п.D).
    const full = await loadFullGraph(root, cfg, git);
    assertLenient(full);
    return full;
  };
  const loadGraphStrict = async (): Promise<FullGraph> => {
    const full = await loadGraphLenient();
    if (full.status === "not_available") {
      throw new ArchMcpError("ADAPTER_UNAVAILABLE", "depcruiser toolchain is not installed", {
        hint: "npm run bootstrap",
      });
    }
    if (full.status === "error") {
      const tail = full.evidence.stderr.slice(-400);
      throw new ArchMcpError("EXTERNAL_TOOL_FAILED", `depcruiser failed: ${tail || "unknown error"}`, {
        hint: "run the depcruise command from provenance manually to inspect",
      });
    }
    return full;
  };

  const indexFrom = (full: FullGraph): IndexBlock =>
    buildIndexBlock({
      gitAvailable: git.available,
      depcruiseStatus: full.cached ? "cached" : full.status,
      depcruiseVersion: toolchainVersion(),
      filesSeen: full.filesSeen,
      // T2a: coverage.parsed — файлы (максимум по адаптерам), не узлы графа:
      // symbol-узлы tree-sitter в этот счётчик не входят (R6b).
      parsed: full.parsedFiles,
      unsupported: full.unsupported,
      graphEmpty: full.graph.edges.length === 0,
      // T1.2b: статусы прочих адаптеров реестра (git/depcruiser — из legacy-полей);
      // ТЗ v6, п.2.5: reason (причина not_available, например scip-индексера)
      // доходит и в живом прогоне, и при кэш-хите (GraphCacheEntry.adapterStatuses).
      adapterStatuses: Object.fromEntries(
        full.adapters
          .filter((a) => a.name !== "git" && a.name !== "depcruiser")
          .map((a) => [
            a.name,
            { status: a.status, version: a.version, ...(a.reason !== undefined ? { reason: a.reason } : {}) },
          ]),
      ),
      // P01: счётчики видов рёбер merged → index.kinds (ТЗ рев.6, п.1).
      kindStats: full.kindStats,
    });

  const finish = (input: {
    command: string;
    data: Record<string, unknown>;
    index: IndexBlock;
    cached: boolean;
    truncated: boolean;
  }): ToolContext => {
    const provenance = buildProvenance({
      command: input.command,
      cwd: root,
      gitHead: git.gitHead,
      exitCode: 0,
      cached: input.cached,
    });
    const envelope = successEnvelope({
      workspace: ws.workspace,
      root_used: ws.root_used,
      roots: ws.roots,
      index: input.index,
      data: input.data,
      truncated: input.truncated,
      provenance,
    });
    return {
      name,
      workspace: ws.workspace,
      root_used: ws.root_used,
      roots: ws.roots,
      gitHead: git.gitHead,
      exitCode: 0,
      command: input.command,
      payload: envelope,
      structuredContent: envelope,
      cached: input.cached,
    };
  };

  /**
   * P01 (ТЗ рев.6, п.4): бюджет data-секции = max_bytes − размер конверта
   * без data, то есть − size(index) − служебные поля (workspace, roots,
   * schema_version, _meta.provenance). Замеряется реальный конверт с data={};
   * "{}" занимает 2 байта, они возвращаются полезным данным, поэтому
   * data ≤ бюджета гарантирует JSON конверта ≤ max_bytes (truncated:true в
   * конверте короче false — замер консервативен).
   */
  const dataBudgetFor = (index: IndexBlock, command: string, cached: boolean): number => {
    const probe = successEnvelope({
      workspace: ws.workspace,
      root_used: ws.root_used,
      roots: ws.roots,
      index,
      data: {},
      truncated: false,
      provenance: buildProvenance({ command, cwd: root, gitHead: git.gitHead, exitCode: 0, cached }),
    });
    return maxBytes - Buffer.byteLength(JSON.stringify(probe), "utf8") + 2;
  };

  switch (name) {
    case "stacks": {
      // Алиас: часть arch_status — только блок stacks (до v1.1).
      const full = await loadGraphLenient();
      const data = { stacks: detectStacks(root, cfg.stacks) };
      return finish({ command: `stacks ${root}`, data, index: indexFrom(full), cached: full.cached, truncated: false });
    }

    case "arch_status": {
      const command = `arch_status ${root}`;
      const probe = await archStatusProbe(root, cfg, git);
      if (probe.kind === "building") {
        // ТЗ v3, п.A: arch_status не ждёт построение — немедленный building-ответ
        // (пустые adapters/kinds/missing, нулевая coverage, graph=null).
        const index = buildBuildingIndex(probe.percent);
        const budget = dataBudgetFor(index, command, false);
        const data: Record<string, unknown> = {
          stacks: detectStacks(root, cfg.stacks),
          git: gitPayload(git),
          graph: null,
          toolchain: { status: "building", version: toolchainVersion() },
          hint: HINT_BUILDING,
        };
        const fits = Buffer.byteLength(JSON.stringify(data), "utf8") <= budget;
        return finish({
          command,
          data: fits ? data : { ...data, hint: HINT_BUDGET },
          index,
          cached: false,
          truncated: !fits,
        });
      }
      const full = probe.full;
      assertLenient(full);
      const index = indexFrom(full);
      const budget = dataBudgetFor(index, command, full.cached);
      const data: Record<string, unknown> = {
        stacks: detectStacks(root, cfg.stacks),
        git: gitPayload(git),
        // R6b: legacy-счётчики считают только module-узлы и imports-рёбра.
        graph: {
          modules: full.moduleNodes,
          edge_count: full.importsEdges,
          circular: full.circular,
        },
        toolchain: { status: full.cached ? "ok (cached)" : full.status, version: toolchainVersion() },
      };
      // P01: data фиксированной формы — сверх бюджета ставим truncated+hint.
      const fits = Buffer.byteLength(JSON.stringify(data), "utf8") <= budget;
      return finish({
        command,
        data: fits ? data : { ...data, hint: HINT_BUDGET },
        index,
        cached: full.cached,
        truncated: !fits,
      });
    }

    case "arch_snapshot":
    case "get_graph": {
      // get_graph (до v1.1) = arch_snapshot с scope=full, data = graph-секция.
      const scope = name === "get_graph" ? "full" : normalizeScope(args.scope);
      const full = await loadGraphLenient();

      const adapters = adapterVersions();
      const gid = snapshotId({ graph: full.graph, gitHead: git.gitHead, adapters });
      const stored: StoredSnapshot = {
        snapshot_id: gid,
        workspace: root,
        git_head: git.gitHead,
        ts: new Date().toISOString(),
        // Дельта рев.8: в снимок идёт граф без lineage-columns (только focus).
        graph: stripColumnMeta(full.graph),
        adapters,
      };
      saveSnapshot(cacheRoot(env), stored);

      const toolchain = { status: full.cached ? "ok (cached)" : full.status, version: toolchainVersion() };
      const stacks = detectStacks(root, cfg.stacks);
      const gitPl = gitPayload(git);
      const index = indexFrom(full);
      const command = name === "get_graph" ? `get_graph ${root}` : `arch_snapshot ${root} scope=${scope}`;
      // P01 (п.4): бюджет данных конверта = max_bytes − size(index) − служебные поля.
      const budget = dataBudgetFor(index, command, full.cached);
      // Точный бюджет graph-секции внутри data:
      // - arch_snapshot: data = rest-объект {stacks,git,snapshot_id,toolchain} с
      //   вставкой "graph":<секция> — замер через probe с graph:null (4 байта
      //   "null" подменяются секцией);
      // - get_graph: data = {"snapshot_id":"…",<секция>} — замер по префиксу
      //   (секция разворачивается после snapshot_id).
      const restProbe = Buffer.byteLength(
        JSON.stringify({ stacks, git: gitPl, snapshot_id: gid, toolchain, graph: null }),
        "utf8",
      );
      const graphPrefix = Buffer.byteLength(`{"snapshot_id":"${gid}",`, "utf8");
      const graphBudget =
        name === "get_graph"
          ? Math.max(0, budget - graphPrefix + 1)
          : Math.max(0, budget - restProbe + "null".length);
      const graphSection =
        scope === "full"
          ? enforceBudget(
              {
                nodes: full.graph.nodes,
                // Дельта рев.8: публичная graph-секция без lineage-columns.
                edges: stripColumnMeta(full.graph).edges,
                // R6b: legacy-счётчики — только module-узлы и imports-рёбра.
                modules: full.moduleNodes,
                edge_count: full.importsEdges,
                circular: full.circular,
              },
              graphBudget,
            )
          : {
              modules: full.moduleNodes,
              edge_count: full.importsEdges,
              circular: full.circular,
              truncated: false,
            };

      if (name === "get_graph") {
        const data: Record<string, unknown> = { snapshot_id: gid, ...graphSection };
        return finish({
          command,
          data,
          index,
          cached: full.cached,
          truncated: graphSection.truncated === true,
        });
      }

      const data: Record<string, unknown> = {
        stacks,
        git: gitPl,
        snapshot_id: gid,
        graph: graphSection,
        toolchain,
      };
      return finish({
        command,
        data,
        index,
        cached: full.cached,
        truncated: graphSection.truncated === true,
      });
    }

    case "focus": {
      const node = requireString(args.node, "node");
      const includeTypeOnly = optionalBool(args.include_type_only, "include_type_only");
      const full = await loadGraphStrict();
      const index = indexFrom(full);
      const command = `focus ${root} :: ${node}`;
      // P01 (п.4): size(index) и служебные поля конверта вычитаются из max_bytes.
      const budget = dataBudgetFor(index, command, full.cached);
      const payload = focus(full.graph, root, node, { limit: args.limit, maxBytes: budget, include_type_only: includeTypeOnly });
      return finish({
        command,
        data: { ...payload },
        index,
        cached: full.cached,
        truncated: payload.truncated,
      });
    }

    case "reaches": {
      const target = requireString(args.target, "target");
      const includeTypeOnly = optionalBool(args.include_type_only, "include_type_only");
      const maxDepth = args.max_depth ?? args.maxDepth;
      const full = await loadGraphStrict();
      const index = indexFrom(full);
      const command = `reaches ${root} :: ${target}`;
      const budget = dataBudgetFor(index, command, full.cached);
      const payload = reaches(full.graph, root, target, { maxDepth, maxBytes: budget, include_type_only: includeTypeOnly });
      return finish({
        command,
        data: { ...payload },
        index,
        cached: full.cached,
        truncated: payload.truncated,
      });
    }

    case "impact": {
      const includeTypeOnly = optionalBool(args.include_type_only, "include_type_only");
      const full = await loadGraphStrict();
      const index = indexFrom(full);
      const command = `impact ${root} :: ${(args.changed ?? []).join(", ")}`;
      const budget = dataBudgetFor(index, command, full.cached);
      const payload = impact(full.graph, root, args.changed ?? [], {
        depth: args.depth,
        maxBytes: budget,
        include_type_only: includeTypeOnly,
      });
      return finish({
        command,
        data: { ...payload },
        index,
        cached: full.cached,
        truncated: payload.truncated,
      });
    }

    case "affected_tests": {
      const includeTypeOnly = optionalBool(args.include_type_only, "include_type_only");
      const full = await loadGraphStrict();
      const index = indexFrom(full);
      const command = `affected_tests ${root} :: ${(args.changed ?? []).join(", ")}`;
      const budget = dataBudgetFor(index, command, full.cached);
      const payload = affectedTests(full.graph, root, args.changed ?? [], { maxBytes: budget, include_type_only: includeTypeOnly });
      return finish({
        command,
        data: { ...payload },
        index,
        cached: full.cached,
        truncated: payload.truncated,
      });
    }

    case "search": {
      const query = requireString(args.query, "query");
      const full = await loadGraphStrict();
      const index = indexFrom(full);
      const command = `search ${root} :: ${query}`;
      const budget = dataBudgetFor(index, command, full.cached);
      const payload = search(full.graph, root, query, { kind: args.kind, maxBytes: budget });
      return finish({
        command,
        data: { ...payload },
        index,
        cached: full.cached,
        truncated: payload.truncated,
      });
    }

    case "arch_diff": {
      const full = await loadGraphStrict();
      const cacheDir = cacheRoot(env);
      const adapters = adapterVersions();
      const buildCurrent = async (): Promise<StoredSnapshot> => {
        const snap: StoredSnapshot = {
          snapshot_id: snapshotId({ graph: full.graph, gitHead: git.gitHead, adapters }),
          workspace: root,
          git_head: git.gitHead,
          ts: new Date().toISOString(),
          graph: full.graph,
          adapters,
        };
        saveSnapshot(cacheDir, snap);
        return snap;
      };
      const refCtx = { cacheRoot: cacheDir, workspace: root, buildCurrent };
      const from = await resolveSnapshotRef(args.from, refCtx);
      const to = await resolveSnapshotRef(args.to, refCtx);
      const index = indexFrom(full);
      const command = `arch_diff ${root} :: ${String(args.from)} -> ${String(args.to)}`;
      // P01 (п.4): diffSnapshots = max_bytes − size(index) − служебные поля конверта.
      const budget = dataBudgetFor(index, command, true);
      const payload = diffSnapshots(from.snapshot, to.snapshot, root, {
        maxBytes: budget,
        fromSide: from.side,
        toSide: to.side,
      });
      return finish({
        command,
        data: { ...payload },
        index,
        cached: true,
        truncated: payload.truncated,
      });
    }

    default:
      throw new ArchMcpError("INVALID_ARGUMENT", `unknown tool: ${name}`, {
        hint: "tools: arch_status, arch_snapshot, search, focus, reaches, impact, affected_tests, arch_diff",
      });
  }
}

export function toolResultToMcp(ctx: ToolContext): ToolCallResult {
  return toJsonResult(ctx.payload, ctx.payload._meta.provenance, false, ctx.payload);
}
