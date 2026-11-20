#!/usr/bin/env node
// Fake Claude Code CLI speaking the stream-json protocol, for tests.
// Behaviour via env: FAKE_MODE = ok | fail | silent | exit | noinit ; FAKE_RECORD = file to dump argv/env.
import fs from "node:fs";
import readline from "node:readline";

const mode = process.env.FAKE_MODE ?? "ok";
const args = process.argv.slice(2);
if (process.env.FAKE_RECORD) {
  fs.writeFileSync(process.env.FAKE_RECORD, JSON.stringify({ args, cwd: process.cwd(), env: process.env }));
}
const out = (o) => process.stdout.write(JSON.stringify(o) + "\n");
const sessionId = "sess-123";
let turns = 0;
let inited = false;

async function callTool() {
  const i = args.indexOf("--mcp-config");
  if (i < 0) return null;
  const cfg = JSON.parse(fs.readFileSync(args[i + 1], "utf8"));
  const server = Object.values(cfg.mcpServers)[0];
  const post = async (body) => {
    const r = await fetch(server.url, { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" }, body: JSON.stringify(body) });
    return r.status === 202 ? null : r.json();
  };
  await post({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "fake", version: "1" } } });
  await post({ jsonrpc: "2.0", method: "notifications/initialized" });
  const list = await post({ jsonrpc: "2.0", id: 2, method: "tools/list" });
  const call = await post({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "linear_graphql", arguments: { query: "query { viewer { id } }" } } });
  const bogus = await post({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "nope", arguments: {} } });
  return { list, call, bogus };
}

const rl = readline.createInterface({ input: process.stdin });
rl.on("line", async (line) => {
  const msg = JSON.parse(line);
  if (msg.type !== "user") return;
  turns++;
  if (mode === "exit") process.exit(3);
  if (mode === "noinit") return;
  if (!inited) {
    inited = true;
    out({ type: "system", subtype: "init", session_id: sessionId, model: "fake", permissionMode: "bypassPermissions", tools: [], mcp_servers: [] });
  }
  if (mode === "silent") return;
  let toolInfo = null;
  if (process.env.FAKE_CALL_TOOL) toolInfo = await callTool();
  const text = msg.message.content[0].text;
  out({ type: "assistant", message: { id: "m" + turns, content: [{ type: "text", text: "working on: " + text.slice(0, 40) }], usage: { input_tokens: 1, output_tokens: 1 } }, session_id: sessionId });
  out({ type: "rate_limit_event", rate_limit_info: { status: "allowed" }, session_id: sessionId });
  if (toolInfo) out({ type: "system", subtype: "tool_probe", info: toolInfo });
  if (mode === "fail") {
    out({ type: "result", subtype: "error_during_execution", is_error: true, errors: ["boom"], usage: { input_tokens: 5, output_tokens: 1 }, session_id: sessionId });
    return;
  }
  out({ type: "result", subtype: "success", is_error: false, result: "done " + turns, num_turns: 1, total_cost_usd: 0.01 * turns, usage: { input_tokens: 100, cache_read_input_tokens: 50, output_tokens: 20 }, session_id: sessionId });
});
rl.on("close", () => process.exit(0));
