/** Коды ошибок универсального arch-mcp (ТЗ рев.3). Фиксированный набор. */
export type ErrorCode =
  | "WORKSPACE_NOT_FOUND"
  | "NODE_NOT_FOUND"
  | "AMBIGUOUS_NODE"
  | "INVALID_ARGUMENT"
  | "ADAPTER_UNAVAILABLE"
  | "INDEX_BUILDING"
  | "BUDGET_EXCEEDED"
  | "SNAPSHOT_NOT_FOUND"
  | "EXTERNAL_TOOL_FAILED";

export const ERROR_CODES: readonly ErrorCode[] = [
  "WORKSPACE_NOT_FOUND",
  "NODE_NOT_FOUND",
  "AMBIGUOUS_NODE",
  "INVALID_ARGUMENT",
  "ADAPTER_UNAVAILABLE",
  "INDEX_BUILDING",
  "BUDGET_EXCEEDED",
  "SNAPSHOT_NOT_FOUND",
  "EXTERNAL_TOOL_FAILED",
];

export interface ErrorEnvelope {
  ok: false;
  error: { code: ErrorCode; message: string; hint?: string; candidates?: string[] };
}

/** Ошибка контракта: код + сообщение + необязательные hint/candidates. */
export class ArchMcpError extends Error {
  readonly code: ErrorCode;
  readonly hint?: string;
  readonly candidates?: string[];

  constructor(code: ErrorCode, message: string, opts: { hint?: string; candidates?: string[] } = {}) {
    super(message);
    this.name = "ArchMcpError";
    this.code = code;
    if (opts.hint !== undefined) this.hint = opts.hint;
    if (opts.candidates !== undefined) this.candidates = opts.candidates;
  }

  toEnvelope(): ErrorEnvelope {
    const error: ErrorEnvelope["error"] = { code: this.code, message: this.message };
    if (this.hint !== undefined) error.hint = this.hint;
    if (this.candidates !== undefined) error.candidates = this.candidates;
    return { ok: false, error };
  }
}

export function isArchMcpError(err: unknown): err is ArchMcpError {
  return err instanceof ArchMcpError;
}

/**
 * Любая ошибка → конверт {ok:false,error{code,message,hint,candidates?}}.
 * Неизвестные (внутренние) ошибки кодируются как EXTERNAL_TOOL_FAILED.
 */
export function toErrorEnvelope(err: unknown): ErrorEnvelope {
  if (isArchMcpError(err)) return err.toEnvelope();
  const message = err instanceof Error ? err.message : String(err);
  return {
    ok: false,
    error: { code: "EXTERNAL_TOOL_FAILED", message, hint: "unexpected internal error; see message" },
  };
}
