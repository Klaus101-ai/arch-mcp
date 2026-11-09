// T4b: Dockerfile-адаптер (ТЗ рев.3 §7, решения R19-R21).
// container:<file> + package:<базовый образ> (R19), references-рёбра
// container→package с confidence syntax (R20). Стадии (FROM ... AS name)
// и ссылки на стадии package-узел не порождают. Файлы: Dockerfile и
// *.Dockerfile (без расширения — через listSourceFiles с "").
// R21: module/imports не порождаются. Битый (нет FROM с образом) →
// coverage.unsupported с причиной, без исключения. Ноль файлов → absent.
import { readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { DockerfileParser } from "dockerfile-ast";
import { packageVersion } from "../../cache.ts";
import type { AdapterOutcome, DetailedAdapter } from "../../core/adapters/runner.ts";
import { listSourceFiles, sortDelta } from "../../core/adapters/tree-sitter/init.ts";
import type { Capability, GraphDelta, GraphEdge, GraphNode, ScanContext } from "../../core/adapters/types.ts";

export const DOCKERFILE_ADAPTER_ID = "dockerfile";

/** Кандидаты: Dockerfile (без расширения) и *.Dockerfile (оба регистра). */
function collectCandidates(root: string): string[] {
  const set = new Set<string>();
  for (const rel of listSourceFiles(root, new Set([""]))) {
    if (basename(rel).toLowerCase() === "dockerfile") set.add(rel);
  }
  for (const rel of listSourceFiles(root, new Set([".dockerfile", ".Dockerfile"]))) {
    if (basename(rel).toLowerCase().endsWith(".dockerfile")) set.add(rel);
  }
  return [...set].sort();
}

interface ParsedDockerfile {
  images: string[];
  ok: boolean;
}

/** FROM-образы; стадии (AS name) и ссылки на стадии отбрасываются. */
function parseDockerfile(text: string): ParsedDockerfile {
  let instructions;
  try {
    instructions = DockerfileParser.parse(text).getInstructions();
  } catch {
    return { images: [], ok: false };
  }
  const stages = new Set<string>();
  for (const ins of instructions) {
    if (ins.getKeyword() !== "FROM") continue;
    const args = ins.getArguments().map((a) => a.getValue());
    const asIdx = args.findIndex((a) => a.toUpperCase() === "AS");
    if (asIdx >= 0 && asIdx + 1 < args.length && args[asIdx + 1] !== "") stages.add(args[asIdx + 1]);
  }
  const images: string[] = [];
  for (const ins of instructions) {
    if (ins.getKeyword() !== "FROM") continue;
    const args = ins.getArguments().map((a) => a.getValue()).filter((a) => !a.startsWith("--"));
    const image = args[0];
    if (image !== undefined && image !== "" && !stages.has(image)) images.push(image);
  }
  return { images, ok: images.length > 0 };
}

function buildDelta(root: string, files: string[]): { delta: GraphDelta; reasons: Record<string, string> } {
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  const nodeIds = new Set<string>();
  const edgeKeys = new Set<string>();
  const unsupported: string[] = [];
  const reasons: Record<string, string> = {};
  const pushNode = (n: GraphNode): void => {
    if (nodeIds.has(n.id)) return;
    nodeIds.add(n.id);
    nodes.push(n);
  };
  const pushEdge = (e: GraphEdge): void => {
    const key = `${e.kind}|${e.source}|${e.target}`;
    if (edgeKeys.has(key)) return;
    edgeKeys.add(key);
    edges.push(e);
  };

  for (const rel of files) {
    let text: string;
    try {
      text = readFileSync(join(root, rel), "utf8");
    } catch {
      continue; // нечитаемый файл — не кандидат (его нет в покрытии)
    }
    const parsed = parseDockerfile(text);
    if (!parsed.ok) {
      unsupported.push(rel);
      reasons[rel] = "no FROM instruction with a base image";
      continue;
    }
    const containerId = `container:${rel}`;
    pushNode({
      id: containerId,
      kind: "container",
      path: rel,
      name: basename(rel),
      source: DOCKERFILE_ADAPTER_ID,
    });
    for (const image of parsed.images) {
      const packageId = `package:${image}`;
      pushNode({ id: packageId, kind: "package", path: rel, name: image, source: DOCKERFILE_ADAPTER_ID });
      pushEdge({
        source: containerId,
        target: packageId,
        kind: "references",
        file: rel,
        confidence: "syntax",
        meta: { dependencyTypes: ["references"] },
      });
    }
  }

  const sorted = sortDelta(nodes, edges);
  return {
    delta: {
      nodes: sorted.nodes,
      edges: sorted.edges,
      coverage: { files_seen: files.length, parsed: files.length - unsupported.length, unsupported: [...unsupported].sort() },
    },
    reasons,
  };
}

async function outcome(ctx: ScanContext): Promise<AdapterOutcome> {
  const files = collectCandidates(ctx.root);
  if (files.length === 0) return { status: "absent", deltas: [] };
  const { delta, reasons } = buildDelta(ctx.root, files);
  const evidence = Object.keys(reasons).length > 0 ? { unsupported_reasons: reasons } : undefined;
  return { status: "ok", deltas: [delta], evidence };
}

/** T4b: адаптер Dockerfile (ТЗ рев.3 §7, R19-R21). */
export const dockerfileAdapter: DetailedAdapter = {
  id: DOCKERFILE_ADAPTER_ID,
  get version(): string {
    return packageVersion() ?? "0.0.0";
  },
  license: "MIT",
  precision: "syntax",
  priority: 50,
  detect(ctx: ScanContext): Promise<Capability[]> {
    const files = collectCandidates(ctx.root);
    return Promise.resolve(
      files.length > 0 ? [{ id: DOCKERFILE_ADAPTER_ID, confidence: "syntax", detail: `${files.length} files` }] : [],
    );
  },
  async *scan(ctx: ScanContext): AsyncIterable<GraphDelta> {
    const run = await outcome(ctx);
    if (run.status === "ok") yield* run.deltas;
  },
  outcome,
};
