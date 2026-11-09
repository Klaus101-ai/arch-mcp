// T1.2a: контракт адаптеров графа (контракт ТЗ рев.3 §6).
// ID узла — `kind:path#symbol`, repo-relative POSIX.
import type { ArchMcpConfig } from "../../config.ts";
export type Precision = "manifest" | "syntax" | "semantic";
export type NodeKind =
  | "file"
  | "module"
  | "package"
  | "symbol"
  | "table"
  | "view"
  | "api"
  | "config"
  | "doc"
  | "service"
  | "container";
export type EdgeKind =
  | "imports"
  | "calls"
  | "extends"
  | "implements"
  | "reads"
  | "writes"
  | "references"
  | "configures"
  | "deploys"
  | "tests";
export interface WorkspaceContext {
  root: string;
  roots: string[];
  gitHead: string | null;
  files: string[];
  capabilities: Capability[];
}
export interface ScanContext extends WorkspaceContext {
  cacheDir: string;
  timeoutMs: number;
  maxBytes: number;
  /** ТЗ v6, п.2.1: конфиг прогона (заполняется get_graph); адаптеры читают только его. */
  config: ArchMcpConfig;
}
export interface Capability {
  id: string;
  confidence: Precision;
  detail?: string;
}
export interface Adapter {
  id: string;
  version: string;
  license: string;
  precision: Precision;
  priority: number;
  detect(ctx: WorkspaceContext): Promise<Capability[]>;
  scan(ctx: ScanContext): AsyncIterable<GraphDelta>;
}
export interface GraphNode {
  id: string;
  kind: NodeKind;
  path?: string;
  name?: string;
  source: string;
  meta?: Record<string, unknown>;
}
export interface GraphEdge {
  source: string;
  target: string;
  kind: EdgeKind;
  file?: string;
  line?: number;
  confidence: "syntax" | "semantic";
  meta?: Record<string, unknown>;
}
export interface GraphDelta {
  nodes: GraphNode[];
  edges: GraphEdge[];
  coverage: { files_seen: number; parsed: number; unsupported: string[] };
}
