import { performance } from "node:perf_hooks";
import type { AgentEvent, TokenUsage } from "./agent/claude.js";
import type { ToolServer } from "./agent/toolServer.js";
import { normalizeState, type ServiceConfig } from "./config.js";
import { describeError, errorMessage } from "./errors.js";
import type { Logger } from "./log.js";
import { issueRoutable, type AttemptRunner } from "./runner.js";
import { effectiveStates, type TrackerRegistry } from "./tracker/index.js";
import type { Issue, TrackerAdapter } from "./tracker/types.js";
import { validateDispatchConfig } from "./validation.js";
import type { WorkflowStore } from "./workflowStore.js";
import type { WorkspaceManager } from "./workspace.js";

export const CONTINUATION_DELAY_MS = 1000;
const RECENT_EVENTS = 50;

type StopKind = "terminal" | "inactive" | "unroutable" | "missing" | "stalled" | "shutdown";

export interface RecentEvent {
  at: string;
  event: string;
  message: string | null;
}

export interface RunningEntry {
  issue_id: string;
  identifier: string;
  issue: Issue;
  abort: AbortController;
  session_id: string | null;
  thread_id: string | null;
  turn_id: string | null;
  codex_app_server_pid: string | null;
  last_codex_event: string | null;
  last_codex_timestamp: Date | null;
  last_codex_message: string | null;
  codex_input_tokens: number;
  codex_output_tokens: number;
  codex_total_tokens: number;
  last_reported_input_tokens: number;
  last_reported_output_tokens: number;
  last_reported_total_tokens: number;
  cost_usd: number;
  turn_count: number;
  retry_attempt: number | null;
  started_at: Date;
  started_mono: number;
  workspace_path: string | null;
  stop: StopKind | null;
}

export interface RetryEntry {
  issue_id: string;
  identifier: string;
  url: string | null;
  attempt: number;
  due_at_ms: number;
  due_at: Date;
  timer: NodeJS.Timeout;
  error: string | null;
}

interface IssueHistory {
  issue_id: string;
  identifier: string;
  url: string | null;
  workspace_path: string | null;
  restart_count: number;
  last_error: string | null;
  recent_events: RecentEvent[];
  last_status: string;
}

export interface OrchestratorDeps {
  store: WorkflowStore;
  registry: TrackerRegistry;
  logger: Logger;
  workspaces: WorkspaceManager;
  runAttempt: AttemptRunner;
  toolServer: ToolServer | null;
  env?: NodeJS.ProcessEnv;
  /** Test hook: use this adapter instead of building one from config. */
  trackerOverride?: TrackerAdapter;
  checkAgentExecutable?: boolean;
}

export function backoffDelay(attempt: number, maxBackoffMs: number): number {
  const delay = 10000 * Math.pow(2, Math.max(0, attempt - 1));
  return Math.min(delay, maxBackoffMs);
}

/** Dispatch ordering (SPEC 8.2): priority 1..4 first, then oldest, then identifier. */
export function sortForDispatch(issues: Issue[]): Issue[] {
  const bucket = (p: number | null) => (p !== null && p >= 1 && p <= 4 ? p : 99);
  return [...issues].sort((a, b) => {
    const pa = bucket(a.priority);
    const pb = bucket(b.priority);
    if (pa !== pb) return pa - pb;
    const ca = a.created_at ? a.created_at.getTime() : Number.POSITIVE_INFINITY;
    const cb = b.created_at ? b.created_at.getTime() : Number.POSITIVE_INFINITY;
    if (ca !== cb) return ca < cb ? -1 : 1;
    return a.identifier < b.identifier ? -1 : a.identifier > b.identifier ? 1 : 0;
  });
}

/**
 * The single authority for scheduling state (SPEC 7, 8, 16). All mutations go through a
 * serialized operation queue, so ticks, retry timers and worker exits never interleave.
 */
export class Orchestrator {
  readonly running = new Map<string, RunningEntry>();
  readonly claimed = new Set<string>();
  readonly retry_attempts = new Map<string, RetryEntry>();
  readonly completed = new Set<string>();
  codex_totals = { input_tokens: 0, output_tokens: 0, total_tokens: 0, seconds_running: 0, cost_usd: 0 };
  codex_rate_limits: unknown = null;
  lastTickAt: Date | null = null;
  lastDispatchError: string | null = null;
  lastTrackerError: string | null = null;

  private readonly history = new Map<string, IssueHistory>();
  private readonly workers = new Map<string, Promise<void>>();
  private opQueue: Promise<void> = Promise.resolve();
  private tickTimer: NodeJS.Timeout | null = null;
  private tickQueued = false;
  private stopped = false;
  private trackerCache: { key: string; adapter: TrackerAdapter } | null = null;
  private readonly log: Logger;

  constructor(private readonly deps: OrchestratorDeps) {
    this.log = deps.logger;
  }

  // ---------------------------------------------------------------- config helpers

  private get config(): ServiceConfig {
    return this.deps.store.config;
  }

  private states(): { active: Set<string>; terminal: Set<string>; active_states: string[]; terminal_states: string[] } {
    const factory = this.config.tracker.kind ? this.deps.registry.get(this.config.tracker.kind) : undefined;
    const s = effectiveStates(this.config, factory);
    return {
      active: new Set(s.active_states.map(normalizeState)),
      terminal: new Set(s.terminal_states.map(normalizeState)),
      ...s,
    };
  }

  /** Adapter built from the current effective config (rebuilt when tracker config changes). */
  tracker(): TrackerAdapter {
    if (this.deps.trackerOverride) return this.deps.trackerOverride;
    const cfg = this.config;
    const s = this.states();
    const key = JSON.stringify([cfg.tracker, s.active_states, s.terminal_states]);
    if (this.trackerCache?.key === key) return this.trackerCache.adapter;
    const factory = this.deps.registry.get(cfg.tracker.kind ?? "");
    if (!factory) throw new Error(`unsupported tracker.kind ${cfg.tracker.kind}`);
    const adapter = factory.create(cfg.tracker, { active_states: s.active_states, terminal_states: s.terminal_states }, this.deps.env ?? process.env);
    this.trackerCache = { key, adapter };
    return adapter;
  }

  private issueLog(issue: { id: string; identifier: string }): Logger {
    return this.log.child({ issue_id: issue.id, issue_identifier: issue.identifier });
  }

  private historyFor(issue: { id: string; identifier: string; url?: string | null }): IssueHistory {
    let h = this.history.get(issue.identifier);
    if (!h) {
      h = {
        issue_id: issue.id,
        identifier: issue.identifier,
        url: issue.url ?? null,
        workspace_path: null,
        restart_count: 0,
        last_error: null,
        recent_events: [],
        last_status: "unclaimed",
      };
      this.history.set(issue.identifier, h);
    }
    if (issue.url) h.url = issue.url;
    return h;
  }

  private recordEvent(h: IssueHistory, event: string, message: string | null): void {
    h.recent_events.push({ at: new Date().toISOString(), event, message });
    if (h.recent_events.length > RECENT_EVENTS) h.recent_events.splice(0, h.recent_events.length - RECENT_EVENTS);
  }

  /** Serializes a state-mutating operation. */
  private enqueue(name: string, fn: () => Promise<void> | void): Promise<void> {
    const run = this.opQueue.then(async () => {
      try {
        await fn();
      } catch (err) {
        this.log.error("orchestrator operation failed", { operation: name, reason: errorMessage(err) });
      }
    });
    this.opQueue = run;
    return run;
  }

  // ---------------------------------------------------------------- lifecycle

  /** Startup cleanup + immediate first tick (SPEC 16.1). Config must already be validated. */
  async start(): Promise<void> {
    await this.startupTerminalCleanup();
    this.scheduleTick(0);
  }

  async startupTerminalCleanup(): Promise<void> {
    const s = this.states();
    try {
      const issues = await this.tracker().fetchIssuesByStates(s.terminal_states);
      let removed = 0;
      for (const issue of issues) {
        if (await this.deps.workspaces.removeForIssue({ issue_id: issue.id, issue_identifier: issue.identifier })) removed++;
      }
      this.log.info("startup terminal cleanup completed", { terminal_issues: issues.length, removed });
    } catch (err) {
      this.log.warn("startup terminal cleanup failed; continuing", { reason: describeError(err) });
    }
  }

  scheduleTick(delayMs: number): void {
    if (this.stopped) return;
    if (this.tickTimer) clearTimeout(this.tickTimer);
    this.tickTimer = setTimeout(() => {
      this.tickTimer = null;
      void this.enqueue("tick", () => this.tick());
    }, delayMs);
  }

  /** Best-effort immediate poll (HTTP `/refresh`). Returns whether it was coalesced. */
  requestRefresh(): boolean {
    if (this.tickQueued) return true;
    this.tickQueued = true;
    void this.enqueue("refresh", async () => {
      this.tickQueued = false;
      await this.tick();
    });
    return false;
  }

  async stop(timeoutMs = 15000): Promise<void> {
    this.stopped = true;
    if (this.tickTimer) clearTimeout(this.tickTimer);
    for (const r of this.retry_attempts.values()) clearTimeout(r.timer);
    this.retry_attempts.clear();
    for (const entry of this.running.values()) {
      entry.stop = entry.stop ?? "shutdown";
      entry.abort.abort();
    }
    const all = Promise.allSettled([...this.workers.values()]);
    await Promise.race([all, new Promise((r) => setTimeout(r, timeoutMs).unref())]);
  }

  /** Waits until queued operations finish (tests). */
  async idle(): Promise<void> {
    let q: Promise<void>;
    do {
      q = this.opQueue;
      await q;
    } while (q !== this.opQueue);
  }

  // ---------------------------------------------------------------- tick

  async tick(): Promise<void> {
    if (this.stopped) return;
    this.lastTickAt = new Date();
    try {
      // Defensive reload in case a watch event was missed (SPEC 6.2).
      this.deps.store.reloadIfChanged();
      await this.reconcile();

      const validation = validateDispatchConfig(this.config, this.deps.registry, this.deps.env, {
        checkAgentExecutable: this.deps.checkAgentExecutable,
      });
      if (validation.length) {
        this.lastDispatchError = validation.join("; ");
        this.log.error("dispatch validation failed; skipping dispatch this tick", { reason: this.lastDispatchError });
        return;
      }
      this.lastDispatchError = null;

      const s = this.states();
      let issues: Issue[];
      try {
        issues = await this.tracker().fetchIssuesByStates(s.active_states);
        this.lastTrackerError = null;
      } catch (err) {
        this.lastTrackerError = describeError(err);
        this.log.error("candidate fetch failed; skipping dispatch this tick", { reason: this.lastTrackerError });
        return;
      }

      for (const issue of sortForDispatch(issues)) {
        if (this.availableSlots() <= 0) break;
        if (this.shouldDispatch(issue)) this.dispatch(issue, null);
      }
    } finally {
      this.scheduleTick(this.config.polling.interval_ms);
    }
  }

  availableSlots(): number {
    return Math.max(this.config.agent.max_concurrent_agents - this.running.size, 0);
  }

  private stateSlotsAvailable(issue: Issue): boolean {
    const key = normalizeState(issue.state);
    const limit = this.config.agent.max_concurrent_agents_by_state[key] ?? this.config.agent.max_concurrent_agents;
    let count = 0;
    for (const e of this.running.values()) if (normalizeState(e.issue.state) === key) count++;
    return count < limit;
  }

  private isActive(issue: Issue): boolean {
    const s = this.states();
    const st = normalizeState(issue.state);
    return s.active.has(st) && !s.terminal.has(st);
  }

  shouldDispatch(issue: Issue): boolean {
    if (!issue.id || !issue.identifier || !issue.title || !issue.state) return false;
    if (!this.isActive(issue)) return false;
    if (!issueRoutable(issue, this.config.tracker.required_labels)) return false;
    if (this.running.has(issue.id) || this.claimed.has(issue.id)) return false;
    if (this.availableSlots() <= 0) return false;
    return this.stateSlotsAvailable(issue);
  }

  // ---------------------------------------------------------------- dispatch / worker

  dispatch(issue: Issue, attempt: number | null): void {
    const cfg = this.config;
    const ilog = this.issueLog(issue);
    const abort = new AbortController();
    const entry: RunningEntry = {
      issue_id: issue.id,
      identifier: issue.identifier,
      issue,
      abort,
      session_id: null,
      thread_id: null,
      turn_id: null,
      codex_app_server_pid: null,
      last_codex_event: null,
      last_codex_timestamp: null,
      last_codex_message: null,
      codex_input_tokens: 0,
      codex_output_tokens: 0,
      codex_total_tokens: 0,
      last_reported_input_tokens: 0,
      last_reported_output_tokens: 0,
      last_reported_total_tokens: 0,
      cost_usd: 0,
      turn_count: 0,
      retry_attempt: attempt,
      started_at: new Date(),
      started_mono: performance.now(),
      workspace_path: null,
      stop: null,
    };

    const existingRetry = this.retry_attempts.get(issue.id);
    if (existingRetry) clearTimeout(existingRetry.timer);
    this.retry_attempts.delete(issue.id);
    this.running.set(issue.id, entry);
    this.claimed.add(issue.id);
    const h = this.historyFor(issue);
    h.issue_id = issue.id;
    h.last_status = "running";
    if (attempt !== null) h.restart_count++;
    this.recordEvent(h, "dispatched", attempt === null ? "first attempt" : `attempt ${attempt}`);
    ilog.info("dispatching issue", { attempt: attempt ?? 0, state: issue.state });

    let tracker: TrackerAdapter;
    try {
      tracker = this.tracker();
    } catch (err) {
      this.running.delete(issue.id);
      this.scheduleRetry(issue.id, issue.identifier, issue.url, (attempt ?? 0) + 1, `failed to spawn agent: ${errorMessage(err)}`, false);
      return;
    }
    const s = this.states();
    const sessionLog = ilog;
    const promise = this.deps
      .runAttempt(issue, attempt, {
        config: cfg,
        promptTemplate: this.deps.store.effective.definition.prompt_template,
        tracker,
        activeStates: s.active_states,
        workspaces: this.deps.workspaces,
        toolServer: this.deps.toolServer,
        logger: sessionLog,
        signal: abort.signal,
        env: this.deps.env,
        onEvent: (ev) => this.onAgentEvent(issue.id, ev),
        onWorkspace: (p) => {
          entry.workspace_path = p;
          h.workspace_path = p;
        },
        onIssueRefreshed: (i) => {
          if (this.running.get(issue.id) === entry) entry.issue = i;
        },
      })
      .then(
        () => this.enqueue("worker_exit", () => this.onWorkerExit(entry, null)),
        (err) => this.enqueue("worker_exit", () => this.onWorkerExit(entry, err)),
      );
    this.workers.set(issue.id, promise);
    void promise.finally(() => {
      if (this.workers.get(issue.id) === promise) this.workers.delete(issue.id);
    });
  }

  /** Codex/agent update event (SPEC 7.3, 13.5). */
  onAgentEvent(issueId: string, ev: AgentEvent): void {
    const entry = this.running.get(issueId);
    if (!entry) return;
    entry.last_codex_event = ev.event;
    entry.last_codex_timestamp = ev.timestamp;
    if (ev.message !== undefined) entry.last_codex_message = ev.message;
    if (ev.pid) entry.codex_app_server_pid = ev.pid;
    if (ev.session_id) {
      if (ev.session_id !== entry.session_id && ev.turn_id) entry.turn_count++;
      entry.session_id = ev.session_id;
      entry.thread_id = ev.thread_id ?? entry.thread_id;
      entry.turn_id = ev.turn_id ?? entry.turn_id;
    }
    if (ev.usage) this.applyUsage(entry, ev.usage);
    if (typeof ev.cost_usd === "number" && ev.cost_usd >= entry.cost_usd) {
      this.codex_totals.cost_usd += ev.cost_usd - entry.cost_usd;
      entry.cost_usd = ev.cost_usd;
    }
    if (ev.rate_limits !== undefined) this.codex_rate_limits = ev.rate_limits;
    const h = this.historyFor(entry.issue);
    this.recordEvent(h, ev.event, ev.message ?? null);
    if (ev.event !== "notification" && ev.event !== "other_message") {
      this.issueLog(entry.issue).info("agent event", {
        session_id: entry.session_id,
        event: ev.event,
        message: ev.message ? ev.message.slice(0, 200) : undefined,
      });
    }
  }

  /** Absolute thread totals -> deltas, so totals are never double-counted. */
  private applyUsage(entry: RunningEntry, usage: TokenUsage): void {
    const dIn = Math.max(0, usage.input_tokens - entry.last_reported_input_tokens);
    const dOut = Math.max(0, usage.output_tokens - entry.last_reported_output_tokens);
    const dTot = Math.max(0, usage.total_tokens - entry.last_reported_total_tokens);
    entry.codex_input_tokens += dIn;
    entry.codex_output_tokens += dOut;
    entry.codex_total_tokens += dTot;
    entry.last_reported_input_tokens = Math.max(entry.last_reported_input_tokens, usage.input_tokens);
    entry.last_reported_output_tokens = Math.max(entry.last_reported_output_tokens, usage.output_tokens);
    entry.last_reported_total_tokens = Math.max(entry.last_reported_total_tokens, usage.total_tokens);
    this.codex_totals.input_tokens += dIn;
    this.codex_totals.output_tokens += dOut;
    this.codex_totals.total_tokens += dTot;
  }

  /** Worker exit handling (SPEC 16.6). */
  private async onWorkerExit(entry: RunningEntry, err: unknown): Promise<void> {
    if (this.running.get(entry.issue_id) === entry) this.running.delete(entry.issue_id);
    this.codex_totals.seconds_running += (performance.now() - entry.started_mono) / 1000;
    const ilog = this.issueLog(entry.issue);
    const h = this.historyFor(entry.issue);

    if (entry.stop) {
      ilog.info("worker stopped", { reason: entry.stop, session_id: entry.session_id });
      this.recordEvent(h, "stopped", entry.stop);
      switch (entry.stop) {
        case "terminal":
          await this.deps.workspaces.removeForIssue({ issue_id: entry.issue_id, issue_identifier: entry.identifier });
          this.release(entry.issue_id, h, "released (terminal)");
          return;
        case "inactive":
        case "unroutable":
        case "missing":
          this.release(entry.issue_id, h, `released (${entry.stop})`);
          return;
        case "shutdown":
          this.claimed.delete(entry.issue_id);
          h.last_status = "stopped";
          return;
        case "stalled": {
          const attempt = (entry.retry_attempt ?? 0) + 1;
          h.last_error = "stalled: no agent activity";
          this.scheduleRetry(entry.issue_id, entry.identifier, entry.issue.url, attempt, "stalled: no agent activity", false);
          return;
        }
      }
    }

    if (err === null) {
      this.completed.add(entry.issue_id);
      ilog.info("worker completed", { session_id: entry.session_id, outcome: "completed" });
      this.recordEvent(h, "worker_completed", null);
      this.scheduleRetry(entry.issue_id, entry.identifier, entry.issue.url, 1, null, true);
    } else {
      const attempt = (entry.retry_attempt ?? 0) + 1;
      const reason = `worker exited: ${describeError(err)}`;
      h.last_error = reason;
      ilog.warn("worker failed", { session_id: entry.session_id, outcome: "failed", reason });
      this.recordEvent(h, "worker_failed", reason);
      this.scheduleRetry(entry.issue_id, entry.identifier, entry.issue.url, attempt, reason, false);
    }
  }

  private release(issueId: string, h: IssueHistory | null, status: string): void {
    this.claimed.delete(issueId);
    const r = this.retry_attempts.get(issueId);
    if (r) clearTimeout(r.timer);
    this.retry_attempts.delete(issueId);
    this.log.info("claim released", { issue_id: issueId, issue_identifier: h?.identifier, reason: status });
    if (h) {
      h.last_status = status;
      this.recordEvent(h, "released", status);
    }
  }

  // ---------------------------------------------------------------- retries

  scheduleRetry(
    issueId: string,
    identifier: string,
    url: string | null,
    attempt: number,
    error: string | null,
    continuation: boolean,
  ): void {
    if (this.stopped) return;
    const existing = this.retry_attempts.get(issueId);
    if (existing) clearTimeout(existing.timer);
    const delay = continuation ? CONTINUATION_DELAY_MS : backoffDelay(attempt, this.config.agent.max_retry_backoff_ms);
    const timer = setTimeout(() => void this.enqueue("retry", () => this.onRetryTimer(issueId)), delay);
    this.retry_attempts.set(issueId, {
      issue_id: issueId,
      identifier,
      url,
      attempt,
      due_at_ms: performance.now() + delay,
      due_at: new Date(Date.now() + delay),
      timer,
      error,
    });
    this.claimed.add(issueId);
    const h = this.history.get(identifier);
    if (h) {
      h.last_status = "retry_queued";
      this.recordEvent(h, "retry_scheduled", `attempt ${attempt} in ${delay}ms${error ? `: ${error}` : ""}`);
    }
    this.log.info("retry scheduled", {
      issue_id: issueId,
      issue_identifier: identifier,
      attempt,
      delay_ms: delay,
      kind: continuation ? "continuation" : "backoff",
      error: error ?? undefined,
    });
  }

  private async onRetryTimer(issueId: string): Promise<void> {
    const entry = this.retry_attempts.get(issueId);
    if (!entry || this.stopped) return;
    this.retry_attempts.delete(issueId);

    let refreshed: Issue[];
    try {
      refreshed = await this.tracker().fetchIssuesByIds([issueId]);
    } catch (err) {
      this.scheduleRetry(issueId, entry.identifier, entry.url, entry.attempt + 1, `retry refresh failed: ${errorMessage(err)}`, false);
      return;
    }
    const h = this.history.get(entry.identifier) ?? null;
    const issue = refreshed.find((i) => i.id === issueId);
    if (!issue) {
      this.release(issueId, h, "released (not visible)");
      return;
    }
    const s = this.states();
    if (s.terminal.has(normalizeState(issue.state))) {
      await this.deps.workspaces.removeForIssue({ issue_id: issue.id, issue_identifier: issue.identifier });
      this.release(issueId, h, "released (terminal)");
      return;
    }
    if (!this.isActive(issue) || !issueRoutable(issue, this.config.tracker.required_labels) || this.running.has(issueId)) {
      this.release(issueId, h, "released (not eligible)");
      return;
    }
    if (this.availableSlots() <= 0 || !this.stateSlotsAvailable(issue)) {
      this.scheduleRetry(issueId, issue.identifier, issue.url, entry.attempt + 1, "no available orchestrator slots", false);
      return;
    }
    this.dispatch(issue, entry.attempt);
  }

  // ---------------------------------------------------------------- reconciliation

  /** Stall detection + tracker state refresh for running issues (SPEC 8.5, 16.3). */
  async reconcile(): Promise<void> {
    const stallMs = this.config.claude.stall_timeout_ms;
    if (stallMs > 0) {
      const now = Date.now();
      for (const entry of this.running.values()) {
        if (entry.stop) continue;
        const last = (entry.last_codex_timestamp ?? entry.started_at).getTime();
        if (now - last > stallMs) {
          this.issueLog(entry.issue).warn("agent stalled; terminating", { session_id: entry.session_id, elapsed_ms: now - last });
          this.terminate(entry, "stalled");
        }
      }
    }

    const ids = [...this.running.values()].filter((e) => !e.stop).map((e) => e.issue_id);
    if (ids.length === 0) return;
    let refreshed: Issue[];
    try {
      refreshed = await this.tracker().fetchIssuesByIds(ids);
    } catch (err) {
      this.log.warn("running issue refresh failed; keeping workers", { reason: describeError(err) });
      return;
    }
    const s = this.states();
    const returned = new Set<string>();
    for (const issue of refreshed) {
      returned.add(issue.id);
      const entry = this.running.get(issue.id);
      if (!entry || entry.stop) continue;
      const st = normalizeState(issue.state);
      if (s.terminal.has(st)) {
        this.terminate(entry, "terminal");
      } else if (s.active.has(st) && issueRoutable(issue, this.config.tracker.required_labels)) {
        entry.issue = issue;
      } else if (s.active.has(st)) {
        this.terminate(entry, "unroutable");
      } else {
        this.terminate(entry, "inactive");
      }
    }
    for (const id of ids) {
      if (!returned.has(id)) {
        const entry = this.running.get(id);
        if (entry && !entry.stop) this.terminate(entry, "missing");
      }
    }
  }

  private terminate(entry: RunningEntry, kind: StopKind): void {
    entry.stop = kind;
    this.issueLog(entry.issue).info("terminating worker", { reason: kind, session_id: entry.session_id });
    entry.abort.abort();
  }

  // ---------------------------------------------------------------- observability

  snapshot(): Record<string, unknown> {
    const now = performance.now();
    let activeSeconds = 0;
    const running = [...this.running.values()].map((e) => {
      activeSeconds += (now - e.started_mono) / 1000;
      return {
        issue_id: e.issue_id,
        issue_identifier: e.identifier,
        issue_url: e.issue.url,
        issue_title: e.issue.title,
        state: e.issue.state,
        session_id: e.session_id,
        turn_count: e.turn_count,
        last_event: e.last_codex_event,
        last_message: e.last_codex_message ?? "",
        started_at: e.started_at.toISOString(),
        last_event_at: e.last_codex_timestamp?.toISOString() ?? null,
        workspace_path: e.workspace_path,
        stopping: e.stop,
        tokens: {
          input_tokens: e.codex_input_tokens,
          output_tokens: e.codex_output_tokens,
          total_tokens: e.codex_total_tokens,
        },
        cost_usd: e.cost_usd,
      };
    });
    const retrying = [...this.retry_attempts.values()].map((r) => ({
      issue_id: r.issue_id,
      issue_identifier: r.identifier,
      issue_url: r.url,
      attempt: r.attempt,
      due_at: r.due_at.toISOString(),
      error: r.error,
    }));
    return {
      generated_at: new Date().toISOString(),
      counts: { running: running.length, retrying: retrying.length },
      running,
      retrying,
      codex_totals: {
        input_tokens: this.codex_totals.input_tokens,
        output_tokens: this.codex_totals.output_tokens,
        total_tokens: this.codex_totals.total_tokens,
        seconds_running: Math.round((this.codex_totals.seconds_running + activeSeconds) * 10) / 10,
        cost_usd: Math.round(this.codex_totals.cost_usd * 10000) / 10000,
      },
      rate_limits: this.codex_rate_limits,
      health: {
        last_tick_at: this.lastTickAt?.toISOString() ?? null,
        workflow_error: this.deps.store.lastError,
        dispatch_error: this.lastDispatchError,
        tracker_error: this.lastTrackerError,
        max_concurrent_agents: this.config.agent.max_concurrent_agents,
        poll_interval_ms: this.config.polling.interval_ms,
      },
    };
  }

  issueDetails(identifier: string): Record<string, unknown> | null {
    const h = this.history.get(identifier);
    const running = [...this.running.values()].find((e) => e.identifier === identifier);
    const retry = [...this.retry_attempts.values()].find((r) => r.identifier === identifier);
    if (!h && !running && !retry) return null;
    const cfg = this.config;
    return {
      issue_identifier: identifier,
      issue_id: running?.issue_id ?? retry?.issue_id ?? h?.issue_id ?? null,
      issue_url: running?.issue.url ?? retry?.url ?? h?.url ?? null,
      status: running ? "running" : retry ? "retry_queued" : (h?.last_status ?? "unknown"),
      workspace: { path: running?.workspace_path ?? h?.workspace_path ?? null },
      attempts: { restart_count: h?.restart_count ?? 0, current_retry_attempt: retry?.attempt ?? running?.retry_attempt ?? null },
      running: running
        ? {
            session_id: running.session_id,
            turn_count: running.turn_count,
            state: running.issue.state,
            started_at: running.started_at.toISOString(),
            last_event: running.last_codex_event,
            last_message: running.last_codex_message ?? "",
            last_event_at: running.last_codex_timestamp?.toISOString() ?? null,
            tokens: {
              input_tokens: running.codex_input_tokens,
              output_tokens: running.codex_output_tokens,
              total_tokens: running.codex_total_tokens,
            },
            cost_usd: running.cost_usd,
          }
        : null,
      retry: retry ? { attempt: retry.attempt, due_at: retry.due_at.toISOString(), error: retry.error } : null,
      logs: { session_logs_dir: `${cfg.logging.root}` },
      recent_events: h?.recent_events ?? [],
      last_error: h?.last_error ?? null,
      tracked: {},
    };
  }
}
