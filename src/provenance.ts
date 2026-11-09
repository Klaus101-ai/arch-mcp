export interface Provenance {
  command: string;
  cwd: string;
  git_head: string | null;
  ts: string;
  exit_code: number | null;
  cached: boolean;
}

export interface ToolCallResult {
  content: Array<{ type: "text"; text: string }>;
  _meta: { provenance: Provenance };
  /** Машиночитаемая копия payload (query-инструменты focus/reaches/affected_tests). */
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

export function buildProvenance(input: {
  command: string;
  cwd: string;
  gitHead?: string | null;
  exitCode?: number | null;
  cached?: boolean;
}): Provenance {
  return {
    command: input.command,
    cwd: input.cwd,
    git_head: input.gitHead ?? null,
    ts: new Date().toISOString(),
    exit_code: input.exitCode ?? null,
    cached: input.cached ?? false,
  };
}

/** Оборачивает payload инструмента в результат MCP: JSON в text + provenance в _meta. */
export function toJsonResult(
  payload: unknown,
  provenance: Provenance,
  isError = false,
  structuredContent?: Record<string, unknown>,
): ToolCallResult {
  const result: ToolCallResult = {
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
    _meta: { provenance },
  };
  if (structuredContent !== undefined) result.structuredContent = structuredContent;
  if (isError) result.isError = true;
  return result;
}
