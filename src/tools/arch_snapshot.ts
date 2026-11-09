import { toolchainVersion, type DepcruiseEvidence } from "../adapters/depcruiser.ts";
import { inspectGit } from "../adapters/git.ts";
import type { ArchMcpConfig } from "../config.ts";
import { enforceBudget, loadFullGraph } from "./get_graph.ts";
import { detectStacks, type StacksResult } from "./stacks.ts";

export interface SnapshotPayload {
  repo: string;
  stacks: StacksResult;
  git: {
    is_repo: boolean;
    git_head: string | null;
    status_lines: number;
    last_commit: { hash: string; committedAt: string } | null;
  };
  graph: {
    modules: number;
    edges: number;
    circular: Array<{ source: string; target: string }>;
  };
  toolchain: { status: string; version: string | null };
  evidence: DepcruiseEvidence;
  truncated: boolean;
  hint?: string;
  cached: boolean;
}

/**
 * arch_snapshot(repo) → {stacks, git, graph{modules,edges,circular}, toolchain}.
 * T1.2b: граф, кэш и статусы берутся из loadFullGraph (реестр адаптеров) —
 * дублирования прогона/кэша больше нет; форма payload не изменилась.
 */
export async function archSnapshot(repo: string, cfg: ArchMcpConfig): Promise<SnapshotPayload> {
  const git = await inspectGit(repo, cfg.timeoutMs);
  const stacks = detectStacks(repo, cfg.stacks);
  const full = await loadFullGraph(repo, cfg);

  const payload = enforceBudget(
    {
      repo,
      stacks,
      git: {
        is_repo: git.isRepo,
        git_head: git.gitHead,
        status_lines: git.status.length,
        last_commit: git.lastCommit,
      },
      // R6b: legacy-счётчики — только module-узлы и imports-рёбра.
      graph: { modules: full.moduleNodes, edges: full.importsEdges, circular: full.circular },
      toolchain: { status: full.cached ? "ok (cached)" : full.status, version: toolchainVersion() },
      evidence: full.evidence satisfies DepcruiseEvidence,
    },
    cfg.maxResponseBytes,
  );
  return { ...payload, cached: full.cached };
}
