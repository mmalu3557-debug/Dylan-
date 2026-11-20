import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { buildClaudeArgs, ClaudeSession, type AgentEvent } from "../src/agent/claude.js";
import { ToolServer } from "../src/agent/toolServer.js";
import { buildServiceConfig, type ClaudeConfig, type ServiceConfig } from "../src/config.js";
import { SymphonyError } from "../src/errors.js";
import { runAgentAttempt } from "../src/runner.js";
import type { Issue, TrackerAdapter } from "../src/tracker/types.js";
import { WorkspaceManager } from "../src/workspace.js";
import { fakeClaudeCommand, makeIssue, memLogger, tmpDir } from "./helpers.js";

function claudeCfg(command: string, over: Partial<ClaudeConfig> = {}): ClaudeConfig {
  const base = buildServiceConfig({ config: {}, prompt_template: "" }, "/x/WORKFLOW.md").config.claude;
  return { ...base, command, read_timeout_ms: 5000, turn_timeout_ms: 5000, ...over };
}

function startSession(dir: string, env: NodeJS.ProcessEnv, over: Partial<ClaudeConfig> = {}, events: AgentEvent[] = []) {
  const root = path.join(dir, "ws");
  const ws = path.join(root, "ABC-1");
  fs.mkdirSync(ws, { recursive: true });
  const session = ClaudeSession.start({
    config: claudeCfg(fakeClaudeCommand(dir), over),
    workspacePath: ws,
    workspaceRoot: root,
    mcpConfigPath: null,
    env: { ...process.env, ...env },
    onEvent: (e) => events.push(e),
    logger: memLogger().logger,
  });
  return { session, events, ws };
}

describe("claude stream-json client", () => {
  it("builds protocol args with the documented policy", () => {
    const args = buildClaudeArgs(claudeCfg("claude", { model: "opus" }), "/tmp/mcp.json");
    assert.deepEqual(args.slice(0, 8), ["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--permission-mode", "bypassPermissions"]);
    assert.ok(args.includes("--strict-mcp-config"));
    assert.equal(args[args.indexOf("--disallowedTools") + 1], "AskUserQuestion");
    assert.ok(!args.includes("--permission-prompts"));
    const strict = buildClaudeArgs(claudeCfg("claude", { permission_mode: "acceptEdits" }), null);
    assert.equal(strict[strict.indexOf("--permission-prompts") + 1], "none");
  });

  it("runs continuation turns on one thread, with session ids and absolute usage", async () => {
    const dir = tmpDir();
    const record = path.join(dir, "rec.json");
    const { session, events, ws } = startSession(dir, { FAKE_MODE: "ok", FAKE_RECORD: record });
    const t1 = await session.runTurn("first prompt");
    const t2 = await session.runTurn("continue");
    await session.stop();
    assert.equal(t1.session_id, "sess-123-turn-1");
    assert.equal(t2.session_id, "sess-123-turn-2");
    assert.ok(events.some((e) => e.event === "session_started" && e.session_id === "sess-123-turn-1"));
    const completed = events.filter((e) => e.event === "turn_completed");
    assert.deepEqual(completed.map((e) => e.usage?.total_tokens), [170, 340]);
    assert.ok(events.some((e) => e.rate_limits));
    const rec = JSON.parse(fs.readFileSync(record, "utf8"));
    assert.equal(fs.realpathSync(rec.cwd), fs.realpathSync(ws));
  });

  it("maps a failed result to turn_failed", async () => {
    const { session } = startSession(tmpDir(), { FAKE_MODE: "fail" });
    await assert.rejects(session.runTurn("x"), (e: SymphonyError) => e.code === "turn_failed");
    await session.stop();
  });

  it("enforces the read timeout when no init arrives", async () => {
    const { session } = startSession(tmpDir(), { FAKE_MODE: "noinit" }, { read_timeout_ms: 300 });
    await assert.rejects(session.runTurn("x"), (e: SymphonyError) => e.code === "response_timeout");
    await session.stop();
  });

  it("enforces the turn silence timeout", async () => {
    const { session } = startSession(tmpDir(), { FAKE_MODE: "silent" }, { turn_timeout_ms: 300 });
    await assert.rejects(session.runTurn("x"), (e: SymphonyError) => e.code === "turn_timeout");
    await session.stop();
  });

  it("maps process exit to port_exit", async () => {
    const { session } = startSession(tmpDir(), { FAKE_MODE: "exit" });
    await assert.rejects(session.runTurn("x"), (e: SymphonyError) => e.code === "port_exit");
  });

  it("rejects launching outside the workspace root", () => {
    const dir = tmpDir();
    assert.throws(
      () =>
        ClaudeSession.start({
          config: claudeCfg(fakeClaudeCommand(dir)),
          workspacePath: dir,
          workspaceRoot: path.join(dir, "ws"),
          mcpConfigPath: null,
          env: process.env,
          onEvent: () => {},
          logger: memLogger().logger,
        }),
      (e: SymphonyError) => e.code === "invalid_workspace_cwd",
    );
  });
});

describe("agent attempt (workspace + prompt + tools)", () => {
  const toolServer = new ToolServer(memLogger().logger);
  before(() => toolServer.start());
  after(() => toolServer.stop());

  function setup(mode: string, refreshed: (i: Issue) => Issue[], extraEnv: NodeJS.ProcessEnv = {}) {
    const dir = tmpDir();
    const record = path.join(dir, "rec.json");
    const config: ServiceConfig = buildServiceConfig(
      {
        config: {
          workspace: { root: path.join(dir, "ws") },
          logging: { root: path.join(dir, "log") },
          agent: { max_turns: 3 },
          claude: { command: fakeClaudeCommand(dir), read_timeout_ms: 5000, turn_timeout_ms: 5000 },
          hooks: { shell: process.platform === "win32" ? "powershell" : "sh" },
        },
        prompt_template: "",
      },
      path.join(dir, "WORKFLOW.md"),
    ).config;
    const toolCalls: string[] = [];
    const tracker: TrackerAdapter = {
      kind: "linear",
      fetchIssuesByStates: async () => [],
      fetchIssuesByIds: async () => refreshed(makeIssue()),
      agentToolSpecs: () => [{ name: "linear_graphql", description: "d", inputSchema: { type: "object" }, mutates: true }],
      secretEnvironmentNames: () => ["LINEAR_API_KEY"],
      executeAgentTool: async (name, _args, ctx) => {
        toolCalls.push(`${name}:${ctx.issue.identifier}`);
        return { ok: true, output: { data: { viewer: { id: "u1" } } } };
      },
    };
    const events: AgentEvent[] = [];
    const { logger } = memLogger();
    const ctx = {
      config,
      promptTemplate: "Work on {{ issue.identifier }}",
      tracker,
      activeStates: ["Todo", "In Progress"],
      workspaces: new WorkspaceManager(() => config, logger),
      toolServer,
      logger,
      signal: new AbortController().signal,
      onEvent: (e: AgentEvent) => events.push(e),
      onWorkspace: () => {},
      onIssueRefreshed: () => {},
      env: { ...process.env, FAKE_MODE: mode, FAKE_RECORD: record, FAKE_CALL_TOOL: "1", LINEAR_API_KEY: "secret", ...extraEnv },
    };
    return { ctx, events, record, toolCalls };
  }

  it("continues while active, scrubs tracker secrets, and serves tools via MCP", async () => {
    let n = 0;
    const { ctx, events, record, toolCalls } = setup("ok", (i) => [{ ...i, state: ++n < 2 ? "In Progress" : "In Review" }]);
    await runAgentAttempt(makeIssue(), null, ctx);
    assert.equal(events.filter((e) => e.event === "turn_completed").length, 2);
    const rec = JSON.parse(fs.readFileSync(record, "utf8"));
    assert.equal(rec.env.LINEAR_API_KEY, undefined, "tracker secret must not reach the agent");
    assert.equal(rec.env.SYMPHONY_ISSUE_IDENTIFIER, "ABC-1");
    assert.deepEqual(toolCalls, ["linear_graphql:ABC-1", "linear_graphql:ABC-1"]);
    const probe = events.find((e) => e.event === "other_message");
    assert.ok(probe);
  });

  it("stops at max_turns", async () => {
    const { ctx, events } = setup("ok", (i) => [{ ...i, state: "In Progress" }]);
    await runAgentAttempt(makeIssue(), 1, ctx);
    assert.equal(events.filter((e) => e.event === "turn_completed").length, 3);
  });

  it("fails the attempt when the turn fails", async () => {
    const { ctx } = setup("fail", (i) => [i]);
    await assert.rejects(runAgentAttempt(makeIssue(), null, ctx), (e: SymphonyError) => e.code === "turn_failed");
  });

  it("fails the attempt on template errors", async () => {
    const { ctx } = setup("ok", (i) => [i]);
    await assert.rejects(runAgentAttempt(makeIssue(), null, { ...ctx, promptTemplate: "{{ nope }}" }), (e: SymphonyError) => e.code === "template_render_error");
  });
});

describe("MCP tool server", () => {
  it("answers initialize/list/call and rejects unknown sessions and methods", async () => {
    const server = new ToolServer(memLogger().logger);
    await server.start();
    try {
      const tracker = {
        kind: "linear",
        agentToolSpecs: () => [{ name: "t", description: "d", inputSchema: { type: "object" }, mutates: false }],
        executeAgentTool: async () => ({ ok: false as const, error: { category: "x", message: "nope" } }),
      } as unknown as TrackerAdapter;
      const { url } = server.register({ adapter: tracker, getIssue: () => makeIssue(), logger: memLogger().logger });
      const post = (u: string, body: unknown) => fetch(u, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const init = await (await post(url, { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26" } })).json();
      assert.equal(init.result.protocolVersion, "2025-03-26");
      assert.equal((await post(url, { jsonrpc: "2.0", method: "notifications/initialized" })).status, 202);
      const list = await (await post(url, { jsonrpc: "2.0", id: 2, method: "tools/list" })).json();
      assert.equal(list.result.tools[0].name, "t");
      const call = await (await post(url, { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "t", arguments: {} } })).json();
      assert.equal(call.result.isError, true);
      const unknown = await (await post(url, { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "zzz" } })).json();
      assert.equal(unknown.result.isError, true);
      const method = await (await post(url, { jsonrpc: "2.0", id: 5, method: "resources/list" })).json();
      assert.equal(method.error.code, -32601);
      assert.equal((await post(url.replace(/[a-f0-9]+$/, "deadbeef"), {})).status, 404);
      assert.equal((await fetch(url)).status, 405);
    } finally {
      await server.stop();
    }
  });
});
