import type { TrackerConfig } from "../config.js";
import { envReferenceName, normalizeState, resolveEnvReference } from "../config.js";
import type { Logger } from "../log.js";
import {
  type BlockerRef,
  type Issue,
  type ToolResult,
  type ToolSpec,
  type TrackerAdapter,
  TrackerError,
  type TrackerFactory,
} from "./types.js";

/*
 * Linear adapter profile (documented in docs/linear-adapter.md).
 *
 * tracker.kind: "linear"
 * tracker.provider keys:
 *   api_key              secret; default "$LINEAR_API_KEY" (host env fallback LINEAR_API_KEY)
 *   project_slug         Linear project slugId (the trailing id of the project URL)
 *   project_url          alternative to project_slug; slug is extracted from the URL
 *   endpoint             default https://api.linear.app/graphql
 *   assignee             optional: "me" or a Linear user id; other assignees -> dispatchable=false
 *   blocker_gated_states default ["Todo"]; issues in these states with unresolved blockers are not dispatchable
 *   page_size            default 50 (1..250)
 *   timeout_ms           default 30000
 */

export const LINEAR_DEFAULT_ENDPOINT = "https://api.linear.app/graphql";
export const LINEAR_SECRET_ENV = "LINEAR_API_KEY";

export interface LinearSettings {
  apiKey: string;
  apiKeyEnvName: string | null;
  endpoint: string;
  projectSlug: string;
  assignee: string | null;
  blockerGatedStates: string[];
  pageSize: number;
  timeoutMs: number;
}

/** Extracts the project slugId from a Linear project URL (…/project/<name>-<slugId>/…). */
export function slugFromProjectUrl(url: string): string | null {
  const m = /\/project\/([^/?#]+)/.exec(url);
  if (!m) return null;
  const seg = decodeURIComponent(m[1]);
  const idx = seg.lastIndexOf("-");
  const slug = idx >= 0 ? seg.slice(idx + 1) : seg;
  return slug.trim() || null;
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() !== "" ? v.trim() : null;
}

export function resolveLinearSettings(cfg: TrackerConfig, env: NodeJS.ProcessEnv): { settings: LinearSettings | null; errors: string[]; missingSecret: boolean } {
  const p = cfg.provider;
  const errors: string[] = [];
  let missingSecret = false;

  const apiKeyRaw = p.api_key === undefined || p.api_key === null ? `$${LINEAR_SECRET_ENV}` : p.api_key;
  let apiKey = "";
  let apiKeyEnvName: string | null = null;
  if (typeof apiKeyRaw !== "string") {
    errors.push("tracker.provider.api_key must be a string or $VAR reference");
  } else {
    apiKeyEnvName = envReferenceName(apiKeyRaw);
    const resolved = resolveEnvReference(apiKeyRaw, env);
    apiKey = (resolved !== undefined ? resolved : apiKeyRaw).trim();
    if (apiKey === "") {
      missingSecret = true;
      errors.push(
        `missing Linear API key: set the ${apiKeyEnvName ?? LINEAR_SECRET_ENV} environment variable (tracker.provider.api_key)`,
      );
    }
  }

  let projectSlug = str(p.project_slug);
  const projectUrl = str(p.project_url);
  if (!projectSlug && projectUrl) {
    if (/COLE|PASTE|SEU_PROJETO|YOUR/i.test(projectUrl)) {
      errors.push("tracker.provider.project_url ainda está com o texto de exemplo: cole a URL do seu projeto do Linear no WORKFLOW.md");
    } else {
      projectSlug = slugFromProjectUrl(projectUrl);
      if (!projectSlug) errors.push(`could not extract the project slug from tracker.provider.project_url (${projectUrl})`);
    }
  }
  if (!projectSlug && !projectUrl) errors.push("tracker.provider.project_slug (or project_url) is required");

  const endpoint = str(p.endpoint) ?? LINEAR_DEFAULT_ENDPOINT;
  if (!/^https?:\/\//.test(endpoint)) errors.push("tracker.provider.endpoint must be an http(s) URL");

  const assignee = str(p.assignee);
  let gated = ["Todo"];
  if (p.blocker_gated_states !== undefined) {
    if (Array.isArray(p.blocker_gated_states)) gated = p.blocker_gated_states.filter((s): s is string => typeof s === "string");
    else errors.push("tracker.provider.blocker_gated_states must be a list of strings");
  }
  const pageSize = p.page_size === undefined ? 50 : Number(p.page_size);
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 250) errors.push("tracker.provider.page_size must be an integer 1..250");
  const timeoutMs = p.timeout_ms === undefined ? 30000 : Number(p.timeout_ms);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1) errors.push("tracker.provider.timeout_ms must be a positive integer");

  if (errors.length > 0 || !projectSlug) return { settings: null, errors, missingSecret };
  return {
    settings: { apiKey, apiKeyEnvName, endpoint, projectSlug, assignee, blockerGatedStates: gated, pageSize, timeoutMs },
    errors,
    missingSecret,
  };
}

const ISSUE_FIELDS = `
  id identifier title description priority url branchName createdAt updatedAt
  state { name type }
  assignee { id }
  team { id key }
  project { id slugId }
  labels(first: 50) { nodes { name } }
  inverseRelations(first: 50) { nodes { type issue { id identifier state { name type } } } }
`;

const ISSUES_QUERY = `query SymphonyIssues($filter: IssueFilter, $first: Int!, $after: String) {
  issues(filter: $filter, first: $first, after: $after, orderBy: createdAt) {
    nodes { ${ISSUE_FIELDS} }
    pageInfo { hasNextPage endCursor }
  }
}`;

const VIEWER_QUERY = `query SymphonyViewer { viewer { id name email } }`;

type FetchFn = typeof fetch;

export class LinearAdapter implements TrackerAdapter {
  readonly kind = "linear";
  private viewerId: string | null = null;
  private readonly terminal: Set<string>;

  constructor(
    private readonly settings: LinearSettings,
    effective: { active_states: string[]; terminal_states: string[] },
    private readonly logger?: Logger,
    private readonly fetchFn: FetchFn = fetch,
  ) {
    this.terminal = new Set(effective.terminal_states.map(normalizeState));
  }

  /** Raw GraphQL call with error mapping (SPEC 11.4). */
  async graphql(query: string, variables: Record<string, unknown> = {}): Promise<{ data: any; errors?: any[] }> {
    let res: Response;
    try {
      res = await this.fetchFn(this.settings.endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          // Linear personal API keys are sent as-is; OAuth tokens need the Bearer prefix.
          Authorization: this.settings.apiKey.startsWith("lin_oauth_") ? `Bearer ${this.settings.apiKey}` : this.settings.apiKey,
        },
        body: JSON.stringify({ query, variables }),
        signal: AbortSignal.timeout(this.settings.timeoutMs),
      });
    } catch (err) {
      throw new TrackerError("tracker_request", `Linear request failed: ${(err as Error).message}`);
    }
    const text = await res.text().catch(() => "");
    let body: any = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = null;
    }
    const gqlErrors: any[] = Array.isArray(body?.errors) ? body.errors : [];
    const rateLimited = res.status === 429 || gqlErrors.some((e) => e?.extensions?.code === "RATELIMITED");
    if (rateLimited) {
      const reset = Number(res.headers.get("x-ratelimit-requests-reset"));
      throw new TrackerError("tracker_rate_limited", "Linear rate limit exceeded", {
        status: res.status,
        retry_after_ms: Number.isFinite(reset) && reset > 0 ? Math.max(0, reset - Date.now()) : undefined,
      });
    }
    if (!res.ok) {
      const msg = gqlErrors[0]?.message ?? text.slice(0, 300);
      const hint = res.status === 401 || res.status === 403 ? " (check LINEAR_API_KEY)" : "";
      throw new TrackerError("tracker_status", `Linear HTTP ${res.status}: ${msg}${hint}`, { status: res.status });
    }
    if (body === null || typeof body !== "object") {
      throw new TrackerError("tracker_response", "Linear returned a non-JSON response");
    }
    return { data: body.data ?? null, errors: gqlErrors.length ? gqlErrors : undefined };
  }

  private async query(query: string, variables: Record<string, unknown>): Promise<any> {
    const { data, errors } = await this.graphql(query, variables);
    if (errors && errors.length) {
      const authErr = errors.some((e) => e?.extensions?.code === "AUTHENTICATION_ERROR");
      throw new TrackerError(
        authErr ? "tracker_status" : "tracker_response",
        `Linear GraphQL error: ${errors.map((e) => e?.message).join("; ")}`,
      );
    }
    if (!data) throw new TrackerError("tracker_response", "Linear response has no data");
    return data;
  }

  private async resolveViewerId(): Promise<string> {
    if (this.viewerId) return this.viewerId;
    const data = await this.query(VIEWER_QUERY, {});
    const id = data?.viewer?.id;
    if (typeof id !== "string") throw new TrackerError("tracker_response", "Linear viewer query returned no id");
    this.viewerId = id;
    return id;
  }

  private async fetchAll(filter: Record<string, unknown>, mode: "states" | "ids"): Promise<Issue[]> {
    const out: Issue[] = [];
    let after: string | null = null;
    const seenCursors = new Set<string>();
    const assigneeId = this.settings.assignee
      ? this.settings.assignee.toLowerCase() === "me"
        ? await this.resolveViewerId()
        : this.settings.assignee
      : null;
    for (let page = 0; page < 1000; page++) {
      const data = await this.query(ISSUES_QUERY, { filter, first: this.settings.pageSize, after });
      const conn = data?.issues;
      if (!conn || !Array.isArray(conn.nodes) || typeof conn.pageInfo !== "object" || conn.pageInfo === null) {
        throw new TrackerError("tracker_response", "Linear issues payload is malformed");
      }
      for (const node of conn.nodes) {
        const issue = this.normalize(node, assigneeId);
        if (issue) out.push(issue);
        else if (mode === "ids") {
          throw new TrackerError("tracker_response", `Linear returned a malformed issue record (id=${node?.id ?? "?"})`);
        } else {
          this.logger?.warn("linear issue omitted: malformed record", { issue_id: node?.id ?? null });
        }
      }
      if (!conn.pageInfo.hasNextPage) return out;
      const cursor = conn.pageInfo.endCursor;
      if (typeof cursor !== "string" || cursor === "" || seenCursors.has(cursor)) {
        throw new TrackerError("tracker_pagination", "Linear pagination returned hasNextPage without a new endCursor");
      }
      seenCursors.add(cursor);
      after = cursor;
    }
    throw new TrackerError("tracker_pagination", "Linear pagination exceeded 1000 pages");
  }

  async fetchIssuesByStates(stateNames: string[]): Promise<Issue[]> {
    if (stateNames.length === 0) return [];
    return this.fetchAll(
      { project: { slugId: { eq: this.settings.projectSlug } }, state: { name: { in: stateNames } } },
      "states",
    );
  }

  async fetchIssuesByIds(issueIds: string[]): Promise<Issue[]> {
    const ids = [...new Set(issueIds)];
    if (ids.length === 0) return [];
    const issues = await this.fetchAll({ project: { slugId: { eq: this.settings.projectSlug } }, id: { in: ids } }, "ids");
    const seen = new Set<string>();
    return issues.filter((i) => (seen.has(i.id) ? false : (seen.add(i.id), true)));
  }

  /** Maps a Linear node to the normalized issue model. Returns null for malformed required fields. */
  normalize(node: any, assigneeFilter: string | null = null): Issue | null {
    if (!node || typeof node !== "object") return null;
    const id = str(node.id);
    const identifier = str(node.identifier);
    const title = typeof node.title === "string" && node.title.trim() !== "" ? node.title : null;
    const state = typeof node.state?.name === "string" && node.state.name.trim() !== "" ? (node.state.name as string) : null;
    if (!id || !identifier || !title || !state) return null;

    const labelsSet = new Set<string>();
    for (const l of Array.isArray(node.labels?.nodes) ? node.labels.nodes : []) {
      if (typeof l?.name === "string" && l.name.trim() !== "") labelsSet.add(l.name.trim().toLowerCase());
    }

    const blocked_by: BlockerRef[] = [];
    const unresolvedBlockers: BlockerRef[] = [];
    for (const rel of Array.isArray(node.inverseRelations?.nodes) ? node.inverseRelations.nodes : []) {
      if (rel?.type !== "blocks" || !rel.issue || typeof rel.issue !== "object") continue;
      const ref: BlockerRef = {
        id: str(rel.issue.id),
        identifier: str(rel.issue.identifier),
        state: str(rel.issue.state?.name),
      };
      if (!ref.id && !ref.identifier) continue;
      blocked_by.push(ref);
      const type = str(rel.issue.state?.type);
      const resolved =
        type === "completed" || type === "canceled" || (ref.state !== null && this.terminal.has(normalizeState(ref.state)));
      if (!resolved) unresolvedBlockers.push(ref);
    }

    const assigneeId = str(node.assignee?.id);
    const gated = new Set(this.settings.blockerGatedStates.map(normalizeState));
    let dispatchable = true;
    if (gated.has(normalizeState(state)) && unresolvedBlockers.length > 0) dispatchable = false;
    if (assigneeFilter && assigneeId !== assigneeFilter) dispatchable = false;

    const priority = Number.isInteger(node.priority) ? (node.priority as number) : null;
    return {
      id,
      native_ref: {
        provider: "linear",
        issue_id: id,
        team_id: str(node.team?.id),
        team_key: str(node.team?.key),
        project_id: str(node.project?.id),
        project_slug: str(node.project?.slugId),
        state_type: str(node.state?.type),
      },
      identifier,
      title,
      description: typeof node.description === "string" ? node.description : null,
      // Linear: 0 = no priority, 1 = urgent … 4 = low. 0 sorts with null (SPEC 8.2).
      priority,
      state,
      branch_name: str(node.branchName),
      url: str(node.url),
      assignee_id: assigneeId,
      labels: [...labelsSet],
      blocked_by,
      dispatchable,
      created_at: parseDate(node.createdAt),
      updated_at: parseDate(node.updatedAt),
    };
  }

  agentToolSpecs(): ToolSpec[] {
    return [
      {
        name: "linear_graphql",
        description:
          "Run a GraphQL query or mutation against the Linear API using Symphony's credentials " +
          "(you never see the API key). Use it to read the current issue, post comments " +
          "(commentCreate), move the issue between workflow states (issueUpdate with stateId; " +
          "look up state ids via the issue's team.states), and attach links. " +
          "Returns {data} or {errors}.",
        inputSchema: {
          type: "object",
          properties: {
            query: { type: "string", description: "GraphQL document (query or mutation)." },
            variables: { type: "object", description: "Optional GraphQL variables.", additionalProperties: true },
          },
          required: ["query"],
          additionalProperties: false,
        },
        mutates: true,
      },
    ];
  }

  secretEnvironmentNames(): string[] {
    return [...new Set([LINEAR_SECRET_ENV, ...(this.settings.apiKeyEnvName ? [this.settings.apiKeyEnvName] : [])])];
  }

  async executeAgentTool(name: string, args: unknown, _context: { issue: Issue }): Promise<ToolResult> {
    if (name !== "linear_graphql") {
      return { ok: false, error: { category: "unsupported_tool", message: `unsupported tool: ${name}` } };
    }
    const a = args as { query?: unknown; variables?: unknown } | null;
    if (!a || typeof a.query !== "string" || a.query.trim() === "") {
      return { ok: false, error: { category: "invalid_arguments", message: "`query` must be a non-empty string" } };
    }
    if (a.variables !== undefined && (typeof a.variables !== "object" || a.variables === null || Array.isArray(a.variables))) {
      return { ok: false, error: { category: "invalid_arguments", message: "`variables` must be an object" } };
    }
    try {
      const { data, errors } = await this.graphql(a.query, (a.variables as Record<string, unknown>) ?? {});
      if (errors && errors.length) {
        return { ok: false, error: { category: "tracker_response", message: "GraphQL errors", details: { errors, data } } };
      }
      return { ok: true, output: { data } };
    } catch (err) {
      const category = err instanceof TrackerError ? err.category : "tracker_request";
      return { ok: false, error: { category, message: (err as Error).message } };
    }
  }
}

function parseDate(v: unknown): Date | null {
  if (typeof v !== "string") return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

export function linearFactory(logger?: Logger, fetchFn?: FetchFn): TrackerFactory {
  return {
    kind: "linear",
    defaultActiveStates: ["Todo", "In Progress"],
    defaultTerminalStates: ["Done", "Canceled", "Cancelled", "Duplicate", "Closed"],
    validate(cfg, env) {
      return resolveLinearSettings(cfg, env).errors;
    },
    create(cfg, effective, env) {
      const { settings, errors, missingSecret } = resolveLinearSettings(cfg, env);
      if (!settings) {
        throw new TrackerError(missingSecret ? "missing_tracker_secret" : "invalid_tracker_config", errors.join("; "));
      }
      return new LinearAdapter(settings, effective, logger, fetchFn);
    },
    secretEnvironmentNames(cfg) {
      const name = envReferenceName(cfg.provider.api_key);
      return [...new Set([LINEAR_SECRET_ENV, ...(name ? [name] : [])])];
    },
  };
}
