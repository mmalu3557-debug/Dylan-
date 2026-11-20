import type { TrackerConfig } from "../config.js";

export interface BlockerRef {
  id: string | null;
  identifier: string | null;
  state: string | null;
}

/** Normalized issue (SPEC 4.1.1). */
export interface Issue {
  id: string;
  native_ref: Record<string, unknown> | null;
  identifier: string;
  title: string;
  description: string | null;
  priority: number | null;
  state: string;
  branch_name: string | null;
  url: string | null;
  assignee_id: string | null;
  labels: string[];
  blocked_by: BlockerRef[];
  dispatchable: boolean;
  created_at: Date | null;
  updated_at: Date | null;
}

/** Adapter error categories (SPEC 11.4). */
export type TrackerErrorCategory =
  | "unsupported_tracker_kind"
  | "invalid_tracker_config"
  | "missing_tracker_secret"
  | "tracker_request"
  | "tracker_status"
  | "tracker_response"
  | "tracker_pagination"
  | "tracker_rate_limited";

export class TrackerError extends Error {
  readonly category: TrackerErrorCategory;
  readonly code: TrackerErrorCategory;
  readonly retryable: boolean;
  readonly retry_after_ms?: number;
  readonly status?: number;

  constructor(
    category: TrackerErrorCategory,
    message: string,
    extra: { retryable?: boolean; retry_after_ms?: number; status?: number } = {},
  ) {
    super(message);
    this.name = "TrackerError";
    this.category = category;
    this.code = category;
    this.retryable = extra.retryable ?? (category === "tracker_request" || category === "tracker_rate_limited");
    this.retry_after_ms = extra.retry_after_ms;
    this.status = extra.status;
  }
}

/** JSON-schema-described tool advertised to the coding agent (SPEC 10.5 optional extension). */
export interface ToolSpec {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  /** Whether the tool can mutate tracker state. */
  mutates: boolean;
}

export type ToolResult =
  | { ok: true; output: unknown }
  | { ok: false; error: { category: string; message: string; details?: unknown } };

export interface TrackerAdapter {
  readonly kind: string;
  fetchIssuesByStates(stateNames: string[]): Promise<Issue[]>;
  fetchIssuesByIds(issueIds: string[]): Promise<Issue[]>;
  agentToolSpecs(): ToolSpec[];
  /** Env var names holding tracker credentials; removed from the coding agent's environment. */
  secretEnvironmentNames(): string[];
  executeAgentTool(name: string, args: unknown, context: { issue: Issue }): Promise<ToolResult>;
}

export interface TrackerFactory {
  kind: string;
  defaultActiveStates: string[];
  defaultTerminalStates: string[];
  /** Returns validation error messages (empty when the provider config is usable). */
  validate(cfg: TrackerConfig, env: NodeJS.ProcessEnv): string[];
  create(cfg: TrackerConfig, effective: { active_states: string[]; terminal_states: string[] }, env: NodeJS.ProcessEnv): TrackerAdapter;
  /** Static secret env names (used even before an adapter instance exists). */
  secretEnvironmentNames(cfg: TrackerConfig): string[];
}
