import { bootstrap } from "./bootstrap.ts";
import { loadConfig } from "./config.ts";
import { toErrorEnvelope } from "./core/errors.ts";
import { runTool, type ToolArgs } from "./server_core.ts";
import type { SuccessEnvelope } from "./core/envelope.ts";

/**
 * CLI (ТЗ рев.3, п.8): status|snapshot|search|focus|reaches|impact|affected-tests|diff
 * [--workspace <path>] [--json]; без env бюджет — 65536.
 */

const USAGE = `usage: arch-mcp <status|snapshot|search|focus|reaches|impact|affected-tests|diff|bootstrap> [options]
options:
  --workspace <path>        workspace (alias: --repo)
  --json                    print the full JSON envelope
  --scope <summary|full>    arch_snapshot scope (default summary)
  --query <text>            search query
  --kind <file|dir|test|all|module|package|symbol|table|view|api|config|doc|service|container>
                           search kind (default file)
  --node <path>             focus node
  --target <path>           reaches target
  --changed <a,b>           changed paths (repeatable, comma-separated)
  --limit <n>               focus limit (default 50, max 200)
  --max-depth <n>           reaches max_depth (alias: --maxDepth)
  --depth <n>               impact depth (default 10)
  --max-bytes <n>           response budget (default 65536, max 1048576)
  --include-type-only       include type-only edges
  --from <ref> --to <ref>   arch_diff refs: current | git HEAD (7-64 hex, unique prefix ok) | snapshot_id
`;

const TOOL_BY_CMD: Record<string, string> = {
  status: "arch_status",
  snapshot: "arch_snapshot",
  search: "search",
  focus: "focus",
  reaches: "reaches",
  impact: "impact",
  "affected-tests": "affected_tests",
  diff: "arch_diff",
};

class UsageError extends Error {}

function parseArgv(argv: string[]): { command: string; args: ToolArgs; json: boolean } {
  const command = argv[0];
  const args: ToolArgs = {};
  let json = false;
  const changed: string[] = [];

  for (let i = 1; i < argv.length; i++) {
    const flag = argv[i];
    const next = (): string => {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith("--")) throw new UsageError(`missing value for ${flag}`);
      i += 1;
      return value;
    };
    switch (flag) {
      case "--json":
        json = true;
        break;
      case "--workspace":
      case "--repo":
        args.workspace = next();
        break;
      case "--scope":
        args.scope = next();
        break;
      case "--query":
        args.query = next();
        break;
      case "--kind":
        args.kind = next();
        break;
      case "--node":
        args.node = next();
        break;
      case "--target":
        args.target = next();
        break;
      case "--changed":
        changed.push(
          ...next()
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean),
        );
        break;
      case "--limit":
        args.limit = Number(next());
        break;
      case "--max-depth":
      case "--maxDepth":
        args.max_depth = Number(next());
        break;
      case "--depth":
        args.depth = Number(next());
        break;
      case "--max-bytes":
        args.max_bytes = Number(next());
        break;
      case "--include-type-only":
        args.include_type_only = true;
        break;
      case "--from":
        args.from = next();
        break;
      case "--to":
        args.to = next();
        break;
      default:
        throw new UsageError(`unknown option: ${flag}`);
    }
  }
  if (changed.length > 0) args.changed = changed;
  return { command, args, json };
}

function formatStatus(envelope: SuccessEnvelope): string {
  const cfg = loadConfig(process.env);
  const data = envelope.data as {
    stacks?: { stacks?: string[] };
    git?: { is_repo?: boolean; git_head?: string | null };
    graph?: { modules?: number; edge_count?: number; circular?: unknown[] };
    toolchain?: { status?: string; version?: string | null };
  };
  return [
    `workspace: ${envelope.workspace}`,
    `root_used: ${envelope.root_used}`,
    `roots: ${envelope.roots.join(", ")}`,
    `schema_version: ${envelope.schema_version}`,
    `index: ${envelope.index.state} (${envelope.index.progress.percent}%)`,
    `adapters: ${envelope.index.adapters.map((a) => `${a.name}=${a.status}`).join(" ")}`,
    `missing: ${envelope.index.missing.length > 0 ? envelope.index.missing.join(", ") : "-"}`,
    `budget: ${cfg.maxResponseBytes}`,
    `stacks: ${data.stacks?.stacks?.join(" ") ?? "-"}`,
    `git: ${data.git?.is_repo ? `repo ${data.git.git_head ?? ""}`.trim() : "not a git repo"}`,
    `graph: modules=${data.graph?.modules ?? 0} edges=${data.graph?.edge_count ?? 0} circular=${data.graph?.circular?.length ?? 0}`,
    `toolchain: ${data.toolchain?.status ?? "?"}${data.toolchain?.version ? ` ${data.toolchain.version}` : ""}`,
  ].join("\n");
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  const cmd = argv[0];
  if (cmd === undefined || cmd === "" || cmd === "--help" || cmd === "-h") {
    process.stderr.write(USAGE);
    return cmd === undefined || cmd === "" ? 2 : 0;
  }
  if (cmd === "bootstrap") return bootstrap();

  let parsed: { command: string; args: ToolArgs; json: boolean };
  try {
    parsed = parseArgv(argv);
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n${USAGE}`);
    return 2;
  }

  const tool = TOOL_BY_CMD[parsed.command];
  if (tool === undefined) {
    process.stderr.write(USAGE);
    return 2;
  }

  try {
    const ctx = await runTool(tool, parsed.args);
    if (parsed.json) {
      process.stdout.write(`${JSON.stringify(ctx.payload, null, 2)}\n`);
    } else if (tool === "arch_status") {
      process.stdout.write(`${formatStatus(ctx.payload)}\n`);
    } else {
      process.stdout.write(`${JSON.stringify(ctx.payload.data, null, 2)}\n`);
    }
    return 0;
  } catch (err) {
    const envelope = toErrorEnvelope(err);
    if (parsed.json) {
      process.stdout.write(`${JSON.stringify(envelope, null, 2)}\n`);
    } else {
      process.stderr.write(`error ${envelope.error.code}: ${envelope.error.message}\n`);
      if (envelope.error.hint !== undefined) process.stderr.write(`hint: ${envelope.error.hint}\n`);
      if (envelope.error.candidates !== undefined) {
        process.stderr.write(`candidates: ${envelope.error.candidates.join(", ")}\n`);
      }
    }
    return 1;
  }
}

process.exitCode = await main();
