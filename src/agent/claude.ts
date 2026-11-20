import fs from "node:fs";
import path from "node:path";
import type { ChildProcess } from "node:child_process";
import type { ClaudeConfig } from "../config.js";
import { SymphonyError } from "../errors.js";
import type { Logger } from "../log.js";
import { killTree, resolveCommand, spawnResolved } from "../process.js";
import { assertWorkspaceSafe } from "../workspace.js";

/*
 * Coding-agent client for the Claude Code CLI.
 *
 * Symphony's SPEC targets the Codex app-server; this implementation targets Claude Code's
 * equivalent long-lived stdio protocol instead:
 *
 *   claude -p --input-format stream-json --output-format stream-json --verbose ...
 *
 * - Transport: newline-delimited JSON on stdin/stdout; stderr is diagnostics only.
 * - One process == one "thread" (Claude session). `thread_id` is the `session_id` from the
 *   `system/init` message. Each user message written to stdin starts a turn; the turn ends with
 *   a `result` message. `turn_id` is `turn-<n>` (Claude has no native turn id).
 * - Continuation turns are written to the same live process, so the thread history is kept.
 */

export interface TokenUsage {
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
}

export interface AgentEvent {
  event: string;
  timestamp: Date;
  pid: string | null;
  session_id?: string;
  thread_id?: string;
  turn_id?: string;
  message?: string;
  /** Absolute thread totals (cumulative for this process), never deltas. */
  usage?: TokenUsage;
  /** Absolute cost reported by Claude Code for this process (USD). */
  cost_usd?: number;
  rate_limits?: unknown;
}

export interface ClaudeSessionOptions {
  config: ClaudeConfig;
  workspacePath: string;
  workspaceRoot: string;
  mcpConfigPath: string | null;
  env: NodeJS.ProcessEnv;
  onEvent: (ev: AgentEvent) => void;
  logger: Logger;
  rawLogPath?: string | null;
  signal?: AbortSignal;
}

export interface TurnResult {
  turn_id: string;
  session_id: string;
  result_text: string | null;
  num_turns: number | null;
}

const MAX_LINE = 10 * 1024 * 1024;

export function buildClaudeArgs(cfg: ClaudeConfig, mcpConfigPath: string | null): string[] {
  const args = [
    "-p",
    "--input-format",
    "stream-json",
    "--output-format",
    "stream-json",
    "--verbose",
    "--permission-mode",
    cfg.permission_mode,
  ];
  if (cfg.permission_mode !== "bypassPermissions") args.push("--permission-prompts", "none");
  // User-input policy: the agent runs unattended, so the interactive question tool is disabled.
  const disallowed = [...new Set(["AskUserQuestion", ...cfg.disallowed_tools])];
  args.push("--disallowedTools", disallowed.join(","));
  if (cfg.allowed_tools.length) args.push("--allowedTools", cfg.allowed_tools.join(","));
  if (cfg.model) args.push("--model", cfg.model);
  if (mcpConfigPath) {
    args.push("--mcp-config", mcpConfigPath);
    if (cfg.strict_mcp_config) args.push("--strict-mcp-config");
  }
  if (cfg.append_system_prompt) args.push("--append-system-prompt", cfg.append_system_prompt);
  args.push(...cfg.args);
  return args;
}

/** Extracts a short human-readable summary from a stream-json message (observability only). */
export function summarizeMessage(msg: any): string {
  try {
    if (msg?.type === "assistant") {
      const parts: string[] = [];
      for (const block of msg.message?.content ?? []) {
        if (block?.type === "text" && typeof block.text === "string") parts.push(block.text);
        else if (block?.type === "tool_use") parts.push(`[tool ${block.name}]`);
        else if (block?.type === "thinking") parts.push("[thinking]");
      }
      return parts.join(" ").replace(/\s+/g, " ").trim().slice(0, 300);
    }
    if (msg?.type === "user") {
      const blocks = Array.isArray(msg.message?.content) ? msg.message.content : [];
      const n = blocks.filter((b: any) => b?.type === "tool_result").length;
      return n ? `[${n} tool result(s)]` : "[user message]";
    }
    if (msg?.type === "result") return String(msg.result ?? msg.subtype ?? "").replace(/\s+/g, " ").slice(0, 300);
    if (msg?.type === "system") return `[system ${msg.subtype ?? ""}]`;
  } catch {
    /* ignore */
  }
  return `[${msg?.type ?? "unknown"}]`;
}

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

/** Per-turn usage from a `result` message (input includes cache reads/writes). */
export function usageFromResult(result: any): TokenUsage {
  const u = result?.usage ?? {};
  const input = num(u.input_tokens) + num(u.cache_creation_input_tokens) + num(u.cache_read_input_tokens);
  const output = num(u.output_tokens);
  return { input_tokens: input, output_tokens: output, total_tokens: input + output };
}

interface PendingTurn {
  turn_id: string;
  resolve: (r: TurnResult) => void;
  reject: (e: Error) => void;
}

export class ClaudeSession {
  readonly pid: string | null;
  thread_id: string | null = null;
  private child: ChildProcess;
  private buffer = "";
  private stderrTail = "";
  private pending: PendingTurn | null = null;
  private turnCounter = 0;
  private currentTurnId: string | null = null;
  private totals: TokenUsage = { input_tokens: 0, output_tokens: 0, total_tokens: 0 };
  private exited = false;
  private exitInfo = "";
  private silenceTimer: NodeJS.Timeout | null = null;
  private initTimer: NodeJS.Timeout | null = null;
  private rawLog: fs.WriteStream | null = null;
  private readonly opts: ClaudeSessionOptions;
  private readonly abortListener: () => void;
  private readonly exitPromise: Promise<void>;

  private constructor(opts: ClaudeSessionOptions, child: ChildProcess) {
    this.opts = opts;
    this.child = child;
    this.pid = child.pid !== undefined ? String(child.pid) : null;
    if (opts.rawLogPath) {
      try {
        fs.mkdirSync(path.dirname(opts.rawLogPath), { recursive: true });
        this.rawLog = fs.createWriteStream(opts.rawLogPath, { flags: "a" });
        this.rawLog.on("error", () => (this.rawLog = null));
      } catch {
        this.rawLog = null;
      }
    }
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => this.onStdout(chunk));
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      this.stderrTail = (this.stderrTail + chunk).slice(-8000);
    });
    child.stdin?.on("error", () => {
      /* EPIPE when the process dies; handled via exit */
    });
    this.exitPromise = new Promise((resolve) => {
      child.on("close", (code, signal) => {
        this.exited = true;
        this.exitInfo = `exit code ${code ?? "null"}${signal ? ` signal ${signal}` : ""}`;
        this.clearTimers();
        this.rawLog?.end();
        const tail = this.stderrTail.trim().split("\n").slice(-5).join(" | ");
        this.failPending(
          new SymphonyError("port_exit", `claude process exited (${this.exitInfo})${tail ? `: ${tail.slice(0, 1000)}` : ""}`),
        );
        resolve();
      });
    });
    child.on("error", (err) => {
      const code = (err as NodeJS.ErrnoException).code === "ENOENT" ? "agent_not_found" : "port_exit";
      this.failPending(new SymphonyError(code, `claude process error: ${err.message}`));
    });
    this.abortListener = () => {
      this.failPending(new SymphonyError("canceled", "agent run canceled"));
      killTree(this.child);
    };
    opts.signal?.addEventListener("abort", this.abortListener, { once: true });
  }

  /** Launches the Claude Code process in the workspace (SPEC 10.1, 9.5 invariants). */
  static start(opts: ClaudeSessionOptions): ClaudeSession {
    // Invariant 1 + 2: cwd must be the per-issue workspace and inside the workspace root.
    assertWorkspaceSafe(opts.workspaceRoot, opts.workspacePath);
    if (!fs.existsSync(opts.workspacePath) || !fs.statSync(opts.workspacePath).isDirectory()) {
      throw new SymphonyError("invalid_workspace_cwd", `workspace ${opts.workspacePath} is not a directory`);
    }
    const resolved = resolveCommand(opts.config.command, opts.env);
    if (!resolved) {
      throw new SymphonyError("agent_not_found", `Claude Code executable not found: ${opts.config.command}`);
    }
    const args = buildClaudeArgs(opts.config, opts.mcpConfigPath);
    opts.logger.info("agent process launching", { command: resolved.file, cwd: opts.workspacePath });
    const child = spawnResolved(resolved, args, {
      cwd: opts.workspacePath,
      env: opts.env,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    const session = new ClaudeSession(opts, child);
    if (opts.signal?.aborted) session.abortListener();
    return session;
  }

  get alive(): boolean {
    return !this.exited;
  }

  /** Sends a user message and resolves when the turn's `result` arrives (SPEC 10.3). */
  runTurn(prompt: string): Promise<TurnResult> {
    if (this.exited) return Promise.reject(new SymphonyError("port_exit", `claude process already exited (${this.exitInfo})`));
    if (this.pending) return Promise.reject(new SymphonyError("turn_in_progress", "a turn is already running"));
    if (this.opts.signal?.aborted) return Promise.reject(new SymphonyError("canceled", "agent run canceled"));
    this.turnCounter += 1;
    const turn_id = `turn-${this.turnCounter}`;
    this.currentTurnId = turn_id;

    return new Promise<TurnResult>((resolve, reject) => {
      this.pending = { turn_id, resolve, reject };
      const line = JSON.stringify({
        type: "user",
        message: { role: "user", content: [{ type: "text", text: prompt }] },
        parent_tool_use_id: null,
      });
      this.child.stdin?.write(line + "\n");

      if (!this.thread_id) {
        this.initTimer = setTimeout(() => {
          this.failPending(
            new SymphonyError("response_timeout", `no session init from claude within ${this.opts.config.read_timeout_ms}ms`),
          );
          killTree(this.child);
        }, this.opts.config.read_timeout_ms);
      } else {
        this.emit("turn_started", { message: `turn ${turn_id} started` });
      }
      this.resetSilenceTimer();
    });
  }

  /** Closes stdin and waits for exit; force-kills after a grace period. */
  async stop(graceMs = 5000): Promise<void> {
    this.opts.signal?.removeEventListener("abort", this.abortListener);
    if (this.exited) return;
    try {
      this.child.stdin?.end();
    } catch {
      /* ignore */
    }
    const timer = setTimeout(() => killTree(this.child), graceMs);
    await this.exitPromise;
    clearTimeout(timer);
  }

  kill(): void {
    killTree(this.child);
  }

  private sessionIds(): { session_id?: string; thread_id?: string; turn_id?: string } {
    if (!this.thread_id || !this.currentTurnId) return {};
    return { session_id: `${this.thread_id}-${this.currentTurnId}`, thread_id: this.thread_id, turn_id: this.currentTurnId };
  }

  private emit(event: string, extra: Partial<AgentEvent> = {}): void {
    try {
      this.opts.onEvent({ event, timestamp: new Date(), pid: this.pid, ...this.sessionIds(), ...extra });
    } catch (err) {
      this.opts.logger.warn("agent event handler failed", { reason: (err as Error).message });
    }
  }

  private clearTimers(): void {
    if (this.silenceTimer) clearTimeout(this.silenceTimer);
    if (this.initTimer) clearTimeout(this.initTimer);
    this.silenceTimer = null;
    this.initTimer = null;
  }

  private resetSilenceTimer(): void {
    if (this.silenceTimer) clearTimeout(this.silenceTimer);
    if (!this.pending) return;
    this.silenceTimer = setTimeout(() => {
      this.failPending(new SymphonyError("turn_timeout", `no output from claude for ${this.opts.config.turn_timeout_ms}ms`));
      killTree(this.child);
    }, this.opts.config.turn_timeout_ms);
  }

  private failPending(err: Error): void {
    const p = this.pending;
    if (!p) return;
    this.pending = null;
    this.clearTimers();
    const code = err instanceof SymphonyError ? err.code : "turn_failed";
    if (code === "turn_timeout" || code === "response_timeout" || code === "port_exit") {
      this.emit(code === "response_timeout" ? "startup_failed" : "turn_ended_with_error", { message: err.message });
    }
    p.reject(err);
  }

  private onStdout(chunk: string): void {
    this.buffer += chunk;
    let idx: number;
    while ((idx = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, idx).trim();
      this.buffer = this.buffer.slice(idx + 1);
      if (line) this.onLine(line);
    }
    if (this.buffer.length > MAX_LINE) {
      this.buffer = "";
      this.emit("malformed", { message: "stdout line exceeded 10MB; dropped" });
    }
  }

  private onLine(line: string): void {
    this.rawLog?.write(line + "\n");
    this.resetSilenceTimer();
    let msg: any;
    try {
      msg = JSON.parse(line);
    } catch {
      this.emit("malformed", { message: line.slice(0, 200) });
      return;
    }
    switch (msg?.type) {
      case "system":
        if (msg.subtype === "init") {
          const first = !this.thread_id;
          if (typeof msg.session_id === "string") this.thread_id = msg.session_id;
          if (this.initTimer) clearTimeout(this.initTimer);
          this.initTimer = null;
          if (first) {
            const failedMcp = Array.isArray(msg.mcp_servers)
              ? msg.mcp_servers.filter((s: any) => s?.status && s.status !== "connected")
              : [];
            this.emit("session_started", {
              message: `model=${msg.model ?? "?"} permission=${msg.permissionMode ?? "?"}`,
            });
            if (failedMcp.length) {
              this.emit("notification", {
                message: `MCP server(s) not connected: ${failedMcp.map((s: any) => `${s.name}=${s.status}`).join(", ")}`,
              });
            }
          }
        } else {
          this.emit("other_message", { message: summarizeMessage(msg) });
        }
        return;
      case "assistant":
      case "user":
        this.emit("notification", { message: summarizeMessage(msg) });
        return;
      case "rate_limit_event":
        this.emit("notification", { message: "rate limit update", rate_limits: msg.rate_limit_info ?? msg });
        return;
      case "control_request":
        // Approval policy: no interactive approvals. Reject any host control request so the
        // session never waits on us.
        this.child.stdin?.write(
          JSON.stringify({
            type: "control_response",
            response: { subtype: "error", request_id: msg.request_id, error: "Symphony does not handle control requests" },
          }) + "\n",
        );
        this.emit("unsupported_tool_call", { message: `control_request ${msg.request?.subtype ?? ""} rejected` });
        return;
      case "result":
        this.onResult(msg);
        return;
      case "stream_event":
      case "keep_alive":
        return;
      default:
        this.emit("other_message", { message: summarizeMessage(msg) });
    }
  }

  private onResult(msg: any): void {
    const turnUsage = usageFromResult(msg);
    this.totals = {
      input_tokens: this.totals.input_tokens + turnUsage.input_tokens,
      output_tokens: this.totals.output_tokens + turnUsage.output_tokens,
      total_tokens: this.totals.total_tokens + turnUsage.total_tokens,
    };
    const cost = typeof msg.total_cost_usd === "number" ? msg.total_cost_usd : undefined;
    const denials = Array.isArray(msg.permission_denials) ? msg.permission_denials.length : 0;
    const p = this.pending;
    this.pending = null;
    if (this.silenceTimer) clearTimeout(this.silenceTimer);
    this.silenceTimer = null;
    const ok = msg.subtype === "success" && msg.is_error !== true;
    const message = summarizeMessage(msg) + (denials ? ` [${denials} permission denial(s)]` : "");
    if (ok) {
      this.emit("turn_completed", { usage: { ...this.totals }, cost_usd: cost, message });
      p?.resolve({
        turn_id: p.turn_id,
        session_id: `${this.thread_id}-${p.turn_id}`,
        result_text: typeof msg.result === "string" ? msg.result : null,
        num_turns: typeof msg.num_turns === "number" ? msg.num_turns : null,
      });
    } else {
      this.emit("turn_failed", { usage: { ...this.totals }, cost_usd: cost, message: `${msg.subtype}: ${message}` });
      const detail = Array.isArray(msg.errors) ? msg.errors.join("; ") : message;
      p?.reject(new SymphonyError("turn_failed", `claude turn failed (${msg.subtype}): ${detail}`.slice(0, 1000)));
    }
  }
}
