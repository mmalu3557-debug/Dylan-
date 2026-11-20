import os from "node:os";
import path from "node:path";
import { SymphonyError } from "./errors.js";
import type { WorkflowDefinition } from "./workflow.js";

export type HookShell = "bash" | "sh" | "powershell" | "pwsh";
export type HookName = "after_create" | "before_run" | "after_run" | "before_remove";

export interface TrackerConfig {
  kind: string | null;
  /** Adapter-owned settings; unknown keys are preserved verbatim. */
  provider: Record<string, unknown>;
  required_labels: string[];
  /** null = use the adapter's documented default. */
  active_states: string[] | null;
  terminal_states: string[] | null;
}

export interface ClaudeConfig {
  /** Executable (or path) of the Claude Code CLI. Default `claude`. */
  command: string;
  /** Extra CLI args appended after the protocol args. */
  args: string[];
  permission_mode: string;
  model: string | null;
  allowed_tools: string[];
  disallowed_tools: string[];
  append_system_prompt: string | null;
  /** Pass `--strict-mcp-config` so only Symphony's MCP server is loaded. */
  strict_mcp_config: boolean;
  turn_timeout_ms: number;
  read_timeout_ms: number;
  stall_timeout_ms: number;
}

export interface ServiceConfig {
  workflow_path: string;
  workflow_dir: string;
  tracker: TrackerConfig;
  polling: { interval_ms: number };
  workspace: { root: string };
  hooks: {
    after_create: string | null;
    before_run: string | null;
    after_run: string | null;
    before_remove: string | null;
    timeout_ms: number;
    shell: HookShell;
  };
  agent: {
    max_concurrent_agents: number;
    max_turns: number;
    max_retry_backoff_ms: number;
    max_concurrent_agents_by_state: Record<string, number>;
  };
  claude: ClaudeConfig;
  server: { port: number | null; host: string };
  logging: { root: string };
}

export const DEFAULTS = {
  poll_interval_ms: 30000,
  hook_timeout_ms: 60000,
  max_concurrent_agents: 10,
  max_turns: 20,
  max_retry_backoff_ms: 300000,
  turn_timeout_ms: 3600000,
  read_timeout_ms: 5000,
  stall_timeout_ms: 300000,
  claude_command: "claude",
  permission_mode: "bypassPermissions",
};

export function normalizeState(state: string): string {
  return state.trim().toLowerCase();
}

/** Resolves a whole-value `$VAR` / `${VAR}` reference. Returns undefined if `value` is not a reference. */
export function resolveEnvReference(value: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  const m = /^\$(?:\{([A-Za-z_][A-Za-z0-9_]*)\}|([A-Za-z_][A-Za-z0-9_]*))$/.exec(value.trim());
  if (!m) return undefined;
  const name = m[1] ?? m[2];
  return env[name] ?? "";
}

export function envReferenceName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const m = /^\$(?:\{([A-Za-z_][A-Za-z0-9_]*)\}|([A-Za-z_][A-Za-z0-9_]*))$/.exec(value.trim());
  return m ? (m[1] ?? m[2]) : null;
}

/** Expands `~`, `$VAR`, `${VAR}` and Windows `%VAR%` in a local filesystem path value. */
export function expandPath(value: string, env: NodeJS.ProcessEnv = process.env): string {
  let out = value.trim();
  out = out.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g, (_m, a, b) => env[a ?? b] ?? "");
  out = out.replace(/%([A-Za-z_][A-Za-z0-9_()]*)%/g, (m, name) => {
    const v = lookupEnvCaseInsensitive(env, name);
    return v ?? m;
  });
  if (out === "~") out = os.homedir();
  else if (out.startsWith("~/") || out.startsWith("~\\")) out = path.join(os.homedir(), out.slice(2));
  return out;
}

function lookupEnvCaseInsensitive(env: NodeJS.ProcessEnv, name: string): string | undefined {
  if (env[name] !== undefined) return env[name];
  const key = Object.keys(env).find((k) => k.toLowerCase() === name.toLowerCase());
  return key ? env[key] : undefined;
}

function asObject(v: unknown, field: string, errors: string[]): Record<string, unknown> {
  if (v === undefined || v === null) return {};
  if (typeof v === "object" && !Array.isArray(v)) return v as Record<string, unknown>;
  errors.push(`${field} must be a map/object`);
  return {};
}

function asInt(
  v: unknown,
  field: string,
  def: number,
  errors: string[],
  opts: { min?: number } = {},
): number {
  if (v === undefined || v === null || v === "") return def;
  const n = typeof v === "string" ? Number(v.trim()) : v;
  if (typeof n !== "number" || !Number.isFinite(n) || !Number.isInteger(n)) {
    errors.push(`${field} must be an integer (got ${JSON.stringify(v)})`);
    return def;
  }
  if (opts.min !== undefined && n < opts.min) {
    errors.push(`${field} must be >= ${opts.min} (got ${n})`);
    return def;
  }
  return n;
}

function asString(v: unknown, field: string, errors: string[]): string | null {
  if (v === undefined || v === null) return null;
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  errors.push(`${field} must be a string`);
  return null;
}

function asStringList(v: unknown, field: string, errors: string[]): string[] | null {
  if (v === undefined || v === null) return null;
  if (typeof v === "string") return v.split(",").map((s) => s.trim()).filter(Boolean);
  if (Array.isArray(v)) {
    const out: string[] = [];
    for (const item of v) {
      if (typeof item === "string" || typeof item === "number") out.push(String(item));
      else errors.push(`${field} entries must be strings`);
    }
    return out;
  }
  errors.push(`${field} must be a list of strings`);
  return null;
}

function defaultShell(): HookShell {
  return process.platform === "win32" ? "powershell" : "bash";
}

/**
 * Builds the typed service config from a parsed workflow (SPEC 6.1). Returns coercion errors
 * instead of throwing so callers can decide between failing startup and keeping the last
 * known good config.
 */
export function buildServiceConfig(
  def: WorkflowDefinition,
  workflowPath: string,
  opts: { env?: NodeJS.ProcessEnv; portOverride?: number | null; logsRoot?: string | null } = {},
): { config: ServiceConfig; errors: string[] } {
  const env = opts.env ?? process.env;
  const errors: string[] = [];
  const raw = def.config;
  const workflowAbs = path.resolve(workflowPath);
  const workflowDir = path.dirname(workflowAbs);

  // tracker
  const t = asObject(raw.tracker, "tracker", errors);
  const kind = asString(t.kind, "tracker.kind", errors);
  const provider = asObject(t.provider, "tracker.provider", errors);
  const requiredLabels = asStringList(t.required_labels, "tracker.required_labels", errors) ?? [];
  const activeStates = asStringList(t.active_states, "tracker.active_states", errors);
  const terminalStates = asStringList(t.terminal_states, "tracker.terminal_states", errors);

  // polling
  const p = asObject(raw.polling, "polling", errors);
  const interval = asInt(p.interval_ms, "polling.interval_ms", DEFAULTS.poll_interval_ms, errors, { min: 100 });

  // workspace
  const w = asObject(raw.workspace, "workspace", errors);
  let root = path.join(os.tmpdir(), "symphony_workspaces");
  const rootRaw = asString(w.root, "workspace.root", errors);
  if (rootRaw !== null && rootRaw.trim() !== "") {
    const expanded = expandPath(rootRaw, env);
    if (expanded.trim() === "") errors.push(`workspace.root resolved to an empty path (${rootRaw})`);
    else root = path.resolve(workflowDir, expanded);
  }

  // hooks
  const h = asObject(raw.hooks, "hooks", errors);
  const hookStr = (name: HookName): string | null => {
    const s = asString(h[name], `hooks.${name}`, errors);
    return s && s.trim() !== "" ? s : null;
  };
  const shellRaw = asString(h.shell, "hooks.shell", errors);
  let shell: HookShell = defaultShell();
  if (shellRaw !== null) {
    const s = shellRaw.trim().toLowerCase();
    if (s === "bash" || s === "sh" || s === "powershell" || s === "pwsh") shell = s;
    else errors.push(`hooks.shell must be one of bash, sh, powershell, pwsh (got ${shellRaw})`);
  }
  const hookTimeout = asInt(h.timeout_ms, "hooks.timeout_ms", DEFAULTS.hook_timeout_ms, errors, { min: 1 });

  // agent
  const a = asObject(raw.agent, "agent", errors);
  const maxConc = asInt(a.max_concurrent_agents, "agent.max_concurrent_agents", DEFAULTS.max_concurrent_agents, errors, { min: 1 });
  const maxTurns = asInt(a.max_turns, "agent.max_turns", DEFAULTS.max_turns, errors, { min: 1 });
  const maxBackoff = asInt(a.max_retry_backoff_ms, "agent.max_retry_backoff_ms", DEFAULTS.max_retry_backoff_ms, errors, { min: 0 });
  const byStateRaw = asObject(a.max_concurrent_agents_by_state, "agent.max_concurrent_agents_by_state", errors);
  const byState: Record<string, number> = {};
  for (const [k, v] of Object.entries(byStateRaw)) {
    const n = typeof v === "string" ? Number(v) : v;
    if (typeof n === "number" && Number.isInteger(n) && n > 0) byState[normalizeState(k)] = n;
    // invalid entries are ignored (SPEC 5.3.5)
  }

  // claude (this implementation's replacement for the `codex` section; `codex` is accepted as a fallback)
  const codexRaw = asObject(raw.codex, "codex", errors);
  const claudeRaw = { ...codexRaw, ...asObject(raw.claude, "claude", errors) };
  const command = asString(claudeRaw.command, "claude.command", errors) ?? DEFAULTS.claude_command;
  const claude: ClaudeConfig = {
    command: command.trim().startsWith("~") || /[$%]/.test(command) ? expandPath(command, env) : command.trim(),
    args: asStringList(claudeRaw.args, "claude.args", errors) ?? [],
    permission_mode: asString(claudeRaw.permission_mode, "claude.permission_mode", errors) ?? DEFAULTS.permission_mode,
    model: asString(claudeRaw.model, "claude.model", errors),
    allowed_tools: asStringList(claudeRaw.allowed_tools, "claude.allowed_tools", errors) ?? [],
    disallowed_tools: asStringList(claudeRaw.disallowed_tools, "claude.disallowed_tools", errors) ?? [],
    append_system_prompt: asString(claudeRaw.append_system_prompt, "claude.append_system_prompt", errors),
    strict_mcp_config: claudeRaw.strict_mcp_config === undefined ? true : claudeRaw.strict_mcp_config === true,
    turn_timeout_ms: asInt(claudeRaw.turn_timeout_ms, "claude.turn_timeout_ms", DEFAULTS.turn_timeout_ms, errors, { min: 1 }),
    read_timeout_ms: asInt(claudeRaw.read_timeout_ms, "claude.read_timeout_ms", DEFAULTS.read_timeout_ms, errors, { min: 1 }),
    stall_timeout_ms: asInt(claudeRaw.stall_timeout_ms, "claude.stall_timeout_ms", DEFAULTS.stall_timeout_ms, errors),
  };

  // server (HTTP extension, SPEC 13.7)
  const s = asObject(raw.server, "server", errors);
  let port: number | null = null;
  if (s.port !== undefined && s.port !== null) port = asInt(s.port, "server.port", 0, errors, { min: 0 });
  if (opts.portOverride !== undefined && opts.portOverride !== null) port = opts.portOverride;
  const host = asString(s.host, "server.host", errors) ?? "127.0.0.1";

  // logging (extension)
  const l = asObject(raw.logging, "logging", errors);
  const logRootRaw = opts.logsRoot ?? asString(l.root, "logging.root", errors);
  const logRoot = logRootRaw ? path.resolve(workflowDir, expandPath(logRootRaw, env)) : path.join(workflowDir, "log");

  const config: ServiceConfig = {
    workflow_path: workflowAbs,
    workflow_dir: workflowDir,
    tracker: {
      kind: kind ? kind.trim() : null,
      provider,
      required_labels: requiredLabels,
      active_states: activeStates,
      terminal_states: terminalStates,
    },
    polling: { interval_ms: interval },
    workspace: { root },
    hooks: {
      after_create: hookStr("after_create"),
      before_run: hookStr("before_run"),
      after_run: hookStr("after_run"),
      before_remove: hookStr("before_remove"),
      timeout_ms: hookTimeout,
      shell,
    },
    agent: {
      max_concurrent_agents: maxConc,
      max_turns: maxTurns,
      max_retry_backoff_ms: maxBackoff,
      max_concurrent_agents_by_state: byState,
    },
    claude,
    server: { port, host },
    logging: { root: logRoot },
  };
  return { config, errors };
}

/** Throws `invalid_config` if any coercion errors were found. */
export function buildServiceConfigOrThrow(
  def: WorkflowDefinition,
  workflowPath: string,
  opts: { env?: NodeJS.ProcessEnv; portOverride?: number | null; logsRoot?: string | null } = {},
): ServiceConfig {
  const { config, errors } = buildServiceConfig(def, workflowPath, opts);
  if (errors.length > 0) throw new SymphonyError("invalid_config", errors.join("; "));
  return config;
}
