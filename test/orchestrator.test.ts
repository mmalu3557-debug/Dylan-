import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { SymphonyError } from "../src/errors.js";
import { backoffDelay, Orchestrator, sortForDispatch } from "../src/orchestrator.js";
import type { AttemptContext, AttemptRunner } from "../src/runner.js";
import { defaultTrackerRegistry } from "../src/tracker/index.js";
import type { Issue, TrackerAdapter } from "../src/tracker/types.js";
import { WorkflowStore } from "../src/workflowStore.js";
import { WorkspaceManager } from "../src/workspace.js";
import { makeIssue, memLogger, tmpDir, waitFor, writeWorkflow } from "./helpers.js";

class FakeTracker implements TrackerAdapter {
  kind = "linear";
  issues = new Map<string, Issue>();
  failIds = false;
  calls = { states: 0, ids: 0 };
  set(i: Issue) {
    this.issues.set(i.id, i);
  }
  async fetchIssuesByStates(states: string[]) {
    this.calls.states++;
    const s = new Set(states.map((x) => x.toLowerCase()));
    return [...this.issues.values()].filter((i) => s.has(i.state.toLowerCase()));
  }
  async fetchIssuesByIds(ids: string[]) {
    this.calls.ids++;
    if (this.failIds) throw new Error("boom");
    return ids.map((id) => this.issues.get(id)).filter((i): i is Issue => !!i);
  }
  agentToolSpecs() {
    return [];
  }
  secretEnvironmentNames() {
    return [];
  }
  async executeAgentTool() {
    return { ok: false as const, error: { category: "x", message: "x" } };
  }
}

interface Controlled {
  issue: Issue;
  attempt: number | null;
  ctx: AttemptContext;
  resolve: () => void;
  reject: (e: Error) => void;
}

function setup(front = "", opts: { stall?: number } = {}) {
  const dir = tmpDir();
  const wsRoot = path.join(dir, "ws");
  const wf = writeWorkflow(
    dir,
    `tracker:
  kind: linear
  provider:
    project_slug: abc
  active_states: [Todo, In Progress]
  terminal_states: [Done, Canceled]
polling:
  interval_ms: 60000
workspace:
  root: ${JSON.stringify(wsRoot)}
claude:
  command: claude
  stall_timeout_ms: ${opts.stall ?? 300000}
agent:
  max_retry_backoff_ms: 300000
${front}`,
  );
  const env = { ...process.env, LINEAR_API_KEY: "k" };
  const { logger, sink } = memLogger();
  const registry = defaultTrackerRegistry(logger);
  const store = new WorkflowStore(wf, registry, logger, { env, checkAgentExecutable: false });
  store.loadInitial();
  const tracker = new FakeTracker();
  const runs: Controlled[] = [];
  const runAttempt: AttemptRunner = (issue, attempt, ctx) =>
    new Promise<void>((resolve, reject) => {
      runs.push({ issue, attempt, ctx, resolve, reject });
      ctx.onWorkspace(path.join(wsRoot, issue.identifier));
      ctx.signal.addEventListener("abort", () => reject(new SymphonyError("canceled", "canceled")));
    });
  const workspaces = new WorkspaceManager(() => store.config, logger);
  const orch = new Orchestrator({ store, registry, logger, workspaces, runAttempt, toolServer: null, env, trackerOverride: tracker, checkAgentExecutable: false });
  return { orch, tracker, runs, store, wf, wsRoot, sink, workspaces };
}

async function tick(orch: Orchestrator) {
  await orch.tick();
  await orch.idle();
}

describe("orchestrator", () => {
  it("sorts by priority bucket, then oldest, then identifier", () => {
    const d = (s: string) => new Date(s);
    const sorted = sortForDispatch([
      makeIssue({ id: "a", identifier: "A-5", priority: null, created_at: d("2026-01-01") }),
      makeIssue({ id: "b", identifier: "A-4", priority: 0, created_at: d("2025-01-01") }),
      makeIssue({ id: "c", identifier: "A-3", priority: 3, created_at: d("2026-01-01") }),
      makeIssue({ id: "d", identifier: "A-2", priority: 1, created_at: d("2026-02-01") }),
      makeIssue({ id: "e", identifier: "A-1", priority: 3, created_at: d("2025-06-01") }),
      makeIssue({ id: "f", identifier: "A-0", priority: 3, created_at: null }),
    ]);
    assert.deepEqual(sorted.map((i) => i.identifier), ["A-2", "A-1", "A-3", "A-0", "A-4", "A-5"]);
  });

  it("computes exponential backoff with a cap", () => {
    assert.equal(backoffDelay(1, 300000), 10000);
    assert.equal(backoffDelay(2, 300000), 20000);
    assert.equal(backoffDelay(3, 300000), 40000);
    assert.equal(backoffDelay(10, 300000), 300000);
    assert.equal(backoffDelay(3, 15000), 15000);
  });

  it("dispatches eligible issues only, respecting labels, dispatchable and concurrency", async () => {
    const { orch, tracker, runs } = setup(`  max_concurrent_agents: 2\n  max_concurrent_agents_by_state:\n    todo: 1`);
    tracker.set(makeIssue({ id: "1", identifier: "A-1", priority: 1 }));
    tracker.set(makeIssue({ id: "2", identifier: "A-2", priority: 2 }));
    tracker.set(makeIssue({ id: "3", identifier: "A-3", state: "In Progress" }));
    tracker.set(makeIssue({ id: "4", identifier: "A-4", state: "In Progress", dispatchable: false }));
    tracker.set(makeIssue({ id: "5", identifier: "A-5", state: "Backlog" }));
    await tick(orch);
    assert.deepEqual(runs.map((r) => r.issue.identifier).sort(), ["A-1", "A-3"]);
    assert.equal(runs[0].attempt, null);
    // already running/claimed -> no duplicate dispatch
    await tick(orch);
    assert.equal(runs.length, 2);
    await orch.stop();
  });

  it("applies required labels case-insensitively", async () => {
    const { orch, tracker, runs, store, wf } = setup();
    fs.writeFileSync(wf, fs.readFileSync(wf, "utf8").replace("  active_states", "  required_labels: [Symphony]\n  active_states"));
    store.reloadIfChanged();
    tracker.set(makeIssue({ id: "1", identifier: "A-1", labels: ["symphony"] }));
    tracker.set(makeIssue({ id: "2", identifier: "A-2", labels: ["other"] }));
    await tick(orch);
    assert.deepEqual(runs.map((r) => r.issue.identifier), ["A-1"]);
    await orch.stop();
  });

  it("schedules a short continuation retry after a normal exit and re-dispatches with attempt 1", async () => {
    const { orch, tracker, runs } = setup();
    tracker.set(makeIssue({ id: "1", identifier: "A-1" }));
    await tick(orch);
    runs[0].resolve();
    await waitFor(() => orch.retry_attempts.has("1"));
    const r = orch.retry_attempts.get("1")!;
    assert.equal(r.attempt, 1);
    assert.equal(r.error, null);
    assert.ok(orch.completed.has("1"));
    assert.ok(orch.claimed.has("1"));
    await waitFor(() => runs.length === 2, 3000);
    assert.equal(runs[1].attempt, 1);
    await orch.stop();
  });

  it("releases the claim on retry when the issue left active states", async () => {
    const { orch, tracker, runs } = setup();
    tracker.set(makeIssue({ id: "1", identifier: "A-1" }));
    await tick(orch);
    tracker.set(makeIssue({ id: "1", identifier: "A-1", state: "In Review" }));
    runs[0].resolve();
    await waitFor(() => orch.retry_attempts.has("1"));
    await waitFor(() => !orch.claimed.has("1"), 3000);
    assert.equal(runs.length, 1);
    await orch.stop();
  });

  it("uses exponential backoff after failures and records the error", async () => {
    const { orch, tracker, runs } = setup();
    tracker.set(makeIssue({ id: "1", identifier: "A-1" }));
    await tick(orch);
    runs[0].reject(new SymphonyError("turn_failed", "nope"));
    await waitFor(() => orch.retry_attempts.has("1"));
    const r = orch.retry_attempts.get("1")!;
    assert.equal(r.attempt, 1);
    assert.match(r.error ?? "", /turn_failed/);
    const delay = r.due_at.getTime() - Date.now();
    assert.ok(delay > 8000 && delay <= 10000, `delay ${delay}`);
    const snap = orch.snapshot() as any;
    assert.equal(snap.retrying[0].issue_identifier, "A-1");
    assert.equal(snap.retrying[0].attempt, 1);
    await orch.stop();
  });

  it("stops terminal issues and cleans their workspace; inactive ones keep it", async () => {
    const { orch, tracker, runs, wsRoot } = setup();
    tracker.set(makeIssue({ id: "1", identifier: "A-1" }));
    tracker.set(makeIssue({ id: "2", identifier: "A-2" }));
    fs.mkdirSync(path.join(wsRoot, "A-1"), { recursive: true });
    fs.mkdirSync(path.join(wsRoot, "A-2"), { recursive: true });
    await tick(orch);
    assert.equal(runs.length, 2);
    tracker.set(makeIssue({ id: "1", identifier: "A-1", state: "Done" }));
    tracker.set(makeIssue({ id: "2", identifier: "A-2", state: "In Review" }));
    await tick(orch);
    await waitFor(() => orch.running.size === 0);
    await orch.idle();
    assert.equal(fs.existsSync(path.join(wsRoot, "A-1")), false);
    assert.equal(fs.existsSync(path.join(wsRoot, "A-2")), true);
    assert.equal(orch.claimed.size, 0);
    assert.equal(orch.retry_attempts.size, 0);
    await orch.stop();
  });

  it("updates the running snapshot for active issues and keeps workers when refresh fails", async () => {
    const { orch, tracker, runs } = setup();
    tracker.set(makeIssue({ id: "1", identifier: "A-1" }));
    await tick(orch);
    tracker.set(makeIssue({ id: "1", identifier: "A-1", state: "In Progress", title: "new" }));
    await orch.reconcile();
    assert.equal(orch.running.get("1")!.issue.state, "In Progress");
    tracker.failIds = true;
    await orch.reconcile();
    assert.equal(orch.running.size, 1);
    assert.equal(runs.length, 1);
    await orch.stop();
  });

  it("reconciliation with nothing running makes no tracker calls", async () => {
    const { orch, tracker } = setup();
    await orch.reconcile();
    assert.equal(tracker.calls.ids, 0);
  });

  it("kills stalled sessions and schedules a retry", async () => {
    const { orch, tracker, runs } = setup("", { stall: 50 });
    tracker.set(makeIssue({ id: "1", identifier: "A-1" }));
    await tick(orch);
    await new Promise((r) => setTimeout(r, 120));
    await orch.reconcile();
    await waitFor(() => orch.retry_attempts.has("1"));
    assert.match(orch.retry_attempts.get("1")!.error ?? "", /stalled/);
    assert.equal(runs.length, 1);
    await orch.stop();
  });

  it("requeues retries with an explicit reason when no slots are free", async () => {
    const { orch, tracker, runs } = setup(`  max_concurrent_agents: 1`);
    tracker.set(makeIssue({ id: "1", identifier: "A-1", priority: 1 }));
    tracker.set(makeIssue({ id: "2", identifier: "A-2", priority: 2 }));
    await tick(orch);
    assert.equal(runs.length, 1);
    // simulate a retry of A-2 while A-1 occupies the only slot
    orch.scheduleRetry("2", "A-2", null, 1, null, true);
    await waitFor(() => orch.retry_attempts.get("2")?.error === "no available orchestrator slots", 3000);
    assert.equal(orch.retry_attempts.get("2")!.attempt, 2);
    await orch.stop();
  });

  it("aggregates tokens from absolute totals without double counting", async () => {
    const { orch, tracker } = setup();
    tracker.set(makeIssue({ id: "1", identifier: "A-1" }));
    await tick(orch);
    const ev = (total: number) => ({
      event: "turn_completed",
      timestamp: new Date(),
      pid: "1",
      session_id: "s-turn-1",
      thread_id: "s",
      turn_id: "turn-1",
      usage: { input_tokens: total - 10, output_tokens: 10, total_tokens: total },
      rate_limits: { status: "allowed" },
    });
    orch.onAgentEvent("1", ev(100));
    orch.onAgentEvent("1", ev(100));
    orch.onAgentEvent("1", ev(250));
    const snap = orch.snapshot() as any;
    assert.equal(snap.codex_totals.total_tokens, 250);
    assert.equal(snap.running[0].tokens.total_tokens, 250);
    assert.equal(snap.running[0].turn_count, 1);
    assert.deepEqual(snap.rate_limits, { status: "allowed" });
    assert.equal((orch.issueDetails("A-1") as any).status, "running");
    assert.equal(orch.issueDetails("NOPE-1"), null);
    await orch.stop();
  });

  it("skips dispatch when validation fails but keeps reconciling", async () => {
    const { orch, tracker, runs, store, wf } = setup();
    tracker.set(makeIssue({ id: "1", identifier: "A-1" }));
    await tick(orch);
    // invalid reload keeps last good config
    fs.writeFileSync(wf, "---\ntracker: [oops\n---\nx");
    store.reloadIfChanged();
    assert.match(store.lastError ?? "", /keeping last known good/);
    assert.equal(store.config.tracker.kind, "linear");
    tracker.set(makeIssue({ id: "1", identifier: "A-1", state: "Done" }));
    tracker.set(makeIssue({ id: "2", identifier: "A-2" }));
    await tick(orch);
    await waitFor(() => orch.running.has("2") || orch.running.size === 0);
    assert.equal(runs.length, 2, "dispatch still works with the last known good config");
    await orch.stop();
  });

  it("skips dispatch (but not reconciliation) when dispatch validation fails", async () => {
    const { orch, tracker, runs, store } = setup();
    tracker.set(makeIssue({ id: "1", identifier: "A-1" }));
    // Same config, but the orchestrator's environment lost the Linear key.
    const broken = new Orchestrator({ ...(orch as any).deps, env: {} });
    await broken.tick();
    await broken.idle();
    assert.equal(runs.length, 0);
    assert.match(String((broken.snapshot() as any).health.dispatch_error), /LINEAR_API_KEY/);
    assert.equal(store.config.tracker.kind, "linear");
    await broken.stop();
    await orch.stop();
  });

  it("re-applies polling and concurrency changes from a reloaded workflow", async () => {
    const { orch, store, wf } = setup();
    fs.writeFileSync(wf, fs.readFileSync(wf, "utf8").replace("interval_ms: 60000", "interval_ms: 1234").replace("agent:\n", "agent:\n  max_concurrent_agents: 3\n"));
    assert.equal(store.reloadIfChanged(), true);
    assert.equal(store.config.polling.interval_ms, 1234);
    assert.equal(orch.availableSlots(), 3);
    await orch.stop();
  });

  it("startup cleanup removes workspaces of terminal issues", async () => {
    const { orch, tracker, wsRoot } = setup();
    tracker.set(makeIssue({ id: "9", identifier: "A-9", state: "Done" }));
    fs.mkdirSync(path.join(wsRoot, "A-9"), { recursive: true });
    await orch.startupTerminalCleanup();
    assert.equal(fs.existsSync(path.join(wsRoot, "A-9")), false);
  });
});
