import fs from "node:fs";
import path from "node:path";
import { ClaudeSession, type AgentEvent } from "./agent/claude.js";
import type { ToolServer } from "./agent/toolServer.js";
import { normalizeState, type ServiceConfig } from "./config.js";
import { SymphonyError } from "./errors.js";
import type { Logger } from "./log.js";
import { scrubEnv } from "./process.js";
import { renderPrompt } from "./template.js";
import type { Issue, TrackerAdapter } from "./tracker/types.js";
import type { WorkspaceManager } from "./workspace.js";

export interface AttemptContext {
  /** Config snapshot for this attempt (a reload applies to future attempts). */
  config: ServiceConfig;
  promptTemplate: string;
  tracker: TrackerAdapter;
  activeStates: string[];
  workspaces: WorkspaceManager;
  toolServer: ToolServer | null;
  logger: Logger;
  signal: AbortSignal;
  onEvent: (ev: AgentEvent) => void;
  onWorkspace: (wsPath: string) => void;
  onIssueRefreshed: (issue: Issue) => void;
  env?: NodeJS.ProcessEnv;
}

export type AttemptRunner = (issue: Issue, attempt: number | null, ctx: AttemptContext) => Promise<void>;

export function issueRoutable(issue: Issue, requiredLabels: string[]): boolean {
  if (!issue.dispatchable) return false;
  const labels = new Set(issue.labels.map((l) => l.trim().toLowerCase()));
  for (const req of requiredLabels) {
    const r = req.trim().toLowerCase();
    if (r === "" || !labels.has(r)) return false;
  }
  return true;
}

export function continuationPrompt(issue: Issue, turn: number, maxTurns: number): string {
  return [
    `Continue working on ${issue.identifier}: ${issue.title}.`,
    `The issue is still in state "${issue.state}" in the tracker (turn ${turn} of at most ${maxTurns} in this session).`,
    "Review what has been done so far in this session, continue the remaining work, and validate it.",
    "When the work is complete, follow the workflow instructions to hand the issue off (for example, move it to the review state).",
    "If you are blocked, explain why in a tracker comment and hand the issue off as instructed.",
  ].join("\n");
}

/**
 * One worker attempt: workspace + prompt + agent session with in-process continuation turns
 * (SPEC 16.5). Throws on failure; resolves on normal exit.
 */
export const runAgentAttempt: AttemptRunner = async (initialIssue, attempt, ctx) => {
  let issue = initialIssue;
  const cfg = ctx.config;
  const log = ctx.logger;
  const hookCtx = () => ({ issue_id: issue.id, issue_identifier: issue.identifier });

  const workspace = await ctx.workspaces.createForIssue(hookCtx());
  ctx.onWorkspace(workspace.path);
  log.info("workspace ready", { path: workspace.path, created_now: workspace.created_now });

  if (ctx.signal.aborted) throw new SymphonyError("canceled", "agent run canceled");
  if (!(await ctx.workspaces.runHook("before_run", workspace.path, hookCtx()))) {
    throw new SymphonyError("hook_failed", "before_run hook failed");
  }

  // Bind the session's tools to this adapter snapshot and the live issue.
  let toolToken: string | null = null;
  let mcpConfigPath: string | null = null;
  const stateDir = path.join(cfg.logging.root, "sessions", workspace.workspace_key);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  if (ctx.toolServer && ctx.tracker.agentToolSpecs().length > 0) {
    const reg = ctx.toolServer.register({ adapter: ctx.tracker, getIssue: () => issue, logger: log });
    toolToken = reg.token;
    // Kept outside the workspace so it is not committed by the agent.
    fs.mkdirSync(stateDir, { recursive: true });
    mcpConfigPath = path.join(stateDir, `mcp-${stamp}.json`);
    fs.writeFileSync(
      mcpConfigPath,
      JSON.stringify({ mcpServers: { [ctx.tracker.kind]: { type: "http", url: reg.url } } }, null, 2),
      "utf8",
    );
  }

  const env = scrubEnv(ctx.env ?? process.env, ctx.tracker.secretEnvironmentNames());
  env.SYMPHONY_ISSUE_ID = issue.id;
  env.SYMPHONY_ISSUE_IDENTIFIER = issue.identifier;

  let session: ClaudeSession | null = null;
  try {
    try {
      session = ClaudeSession.start({
        config: cfg.claude,
        workspacePath: workspace.path,
        workspaceRoot: cfg.workspace.root,
        mcpConfigPath,
        env,
        onEvent: ctx.onEvent,
        logger: log,
        rawLogPath: path.join(stateDir, `${stamp}.jsonl`),
        signal: ctx.signal,
      });
    } catch (err) {
      throw err instanceof SymphonyError ? err : new SymphonyError("startup_failed", (err as Error).message);
    }

    const maxTurns = cfg.agent.max_turns;
    const active = new Set(ctx.activeStates.map(normalizeState));
    for (let turn = 1; ; turn++) {
      const prompt =
        turn === 1
          ? await renderPrompt(ctx.promptTemplate, issue, attempt)
          : continuationPrompt(issue, turn, maxTurns);
      const result = await session.runTurn(prompt);
      log.info("agent turn completed", { session_id: result.session_id, turn });

      const refreshed = await ctx.tracker.fetchIssuesByIds([issue.id]).catch((err) => {
        throw new SymphonyError("issue_refresh_failed", `issue state refresh error: ${(err as Error).message}`);
      });
      const next = refreshed.find((i) => i.id === issue.id);
      if (!next) {
        log.info("issue no longer visible; ending session");
        break;
      }
      issue = next;
      ctx.onIssueRefreshed(issue);
      if (!active.has(normalizeState(issue.state)) || !issueRoutable(issue, cfg.tracker.required_labels)) {
        log.info("issue left active states; ending session", { state: issue.state });
        break;
      }
      if (turn >= maxTurns) {
        log.info("max turns reached; ending session", { max_turns: maxTurns });
        break;
      }
      if (ctx.signal.aborted) throw new SymphonyError("canceled", "agent run canceled");
    }
  } finally {
    if (session) await session.stop().catch(() => undefined);
    if (toolToken) ctx.toolServer?.unregister(toolToken);
    if (mcpConfigPath) fs.rmSync(mcpConfigPath, { force: true });
    await ctx.workspaces.runHook("after_run", workspace.path, hookCtx()).catch(() => false);
  }
};
