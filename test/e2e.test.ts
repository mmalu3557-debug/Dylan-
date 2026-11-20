import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { fakeClaudeCommand, tmpDir, waitFor, writeWorkflow } from "./helpers.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CLI = path.join(ROOT, "src", "cli.ts");
const TSX = ["--import", import.meta.resolve("tsx")];

function issueNode(state: string) {
  return {
    id: "uuid-1",
    identifier: "DYL-1",
    title: "Criar página de login",
    description: "Tela de login da área logada",
    priority: 1,
    url: "https://linear.app/x/issue/DYL-1",
    branchName: "dyl-1",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    state: { name: state, type: state === "Done" ? "completed" : "started" },
    assignee: null,
    team: { id: "t", key: "DYL" },
    project: { id: "p", slugId: "abc123" },
    labels: { nodes: [] },
    inverseRelations: { nodes: [] },
  };
}

/** Minimal Linear GraphQL stand-in. The agent's tool call moves the issue to "In Review". */
export async function fakeLinear() {
  let state = "Todo";
  const seenAuth: string[] = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      seenAuth.push(String(req.headers.authorization));
      const { query, variables } = JSON.parse(body);
      res.setHeader("Content-Type", "application/json");
      if (query.includes("SymphonyIssues")) {
        const f = variables.filter;
        const match = f.state ? f.state.name.in.includes(state) : f.id.in.includes("uuid-1");
        res.end(JSON.stringify({ data: { issues: { nodes: match ? [issueNode(state)] : [], pageInfo: { hasNextPage: false, endCursor: null } } } }));
      } else if (query.includes("viewer")) {
        state = "In Review";
        res.end(JSON.stringify({ data: { viewer: { id: "u1" } } }));
      } else {
        res.end(JSON.stringify({ errors: [{ message: "unknown query" }] }));
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  return { server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/graphql`, getState: () => state, seenAuth };
}

describe("cli", () => {
  it("errors on a missing explicit workflow path", () => {
    const r = spawnSync(process.execPath, [...TSX, CLI, path.join(tmpDir(), "missing.md")], { encoding: "utf8", cwd: ROOT });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /não encontrado/);
  });

  it("errors when ./WORKFLOW.md is missing in cwd", () => {
    const r = spawnSync(process.execPath, [...TSX, CLI], { encoding: "utf8", cwd: tmpDir() });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /WORKFLOW\.md/);
  });

  it("fails startup cleanly on invalid config", () => {
    const dir = tmpDir();
    const wf = writeWorkflow(dir, "tracker:\n  kind: jira");
    const r = spawnSync(process.execPath, [...TSX, CLI, wf], { encoding: "utf8", cwd: ROOT });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /unsupported tracker.kind/);
  });

  it("runs end-to-end: poll, dispatch, agent turn, tool call, handoff, dashboard API, clean shutdown", { timeout: 60000 }, async () => {
    const linear = await fakeLinear();
    const dir = tmpDir();
    const record = path.join(dir, "rec.json");
    const wf = writeWorkflow(
      dir,
      `tracker:
  kind: linear
  provider:
    api_key: $TEST_LINEAR_KEY
    project_url: https://linear.app/acme/project/area-logada-abc123/overview
    endpoint: ${linear.url}
  active_states: [Todo, In Progress]
  terminal_states: [Done]
polling:
  interval_ms: 500
workspace:
  root: ./workspaces
hooks:
  shell: ${process.platform === "win32" ? "powershell" : "sh"}
  after_create: ${process.platform === "win32" ? "Set-Content -Path created.txt -Value ok" : "echo ok > created.txt"}
claude:
  command: ${JSON.stringify(fakeClaudeCommand(dir))}
  read_timeout_ms: 10000
server:
  port: 0`,
      "Você está trabalhando em {{ issue.identifier }}: {{ issue.title }}",
    );
    const child = spawn(process.execPath, [...TSX, CLI, wf], {
      cwd: dir,
      env: { ...process.env, TEST_LINEAR_KEY: "lin_api_secret", FAKE_MODE: "ok", FAKE_CALL_TOOL: "1", FAKE_RECORD: record },
    });
    let logs = "";
    child.stderr.on("data", (c) => { logs += c; if (process.env.E2E_DEBUG) fs.appendFileSync(process.env.E2E_DEBUG, String(c)); });
    try {
      await waitFor(() => /dashboard listening/.test(logs), 20000);
      const port = /url=http:\/\/127\.0\.0\.1:(\d+)\//.exec(logs)![1];
      await waitFor(() => linear.getState() === "In Review", 20000);
      await waitFor(() => /released \(not eligible\)|retry scheduled/.test(logs), 20000);

      const rec = JSON.parse(fs.readFileSync(record, "utf8"));
      assert.equal(rec.env.TEST_LINEAR_KEY, undefined, "tracker secret is scrubbed from the agent env");
      assert.equal(fs.realpathSync(rec.cwd), fs.realpathSync(path.join(dir, "workspaces", "DYL-1")));
      assert.ok(fs.existsSync(path.join(dir, "workspaces", "DYL-1", "created.txt")));
      assert.ok(linear.seenAuth.every((a) => a === "lin_api_secret"));
      assert.ok(fs.existsSync(path.join(dir, "log", "symphony.log")));

      const state = await (await fetch(`http://127.0.0.1:${port}/api/v1/state`)).json();
      assert.ok(state.codex_totals.total_tokens > 0);
      const details = await (await fetch(`http://127.0.0.1:${port}/api/v1/DYL-1`)).json();
      assert.equal(details.issue_identifier, "DYL-1");
      assert.ok(details.recent_events.some((e: any) => e.event === "turn_completed"));
      assert.equal((await fetch(`http://127.0.0.1:${port}/api/v1/NOPE-9`)).status, 404);
      assert.equal((await fetch(`http://127.0.0.1:${port}/api/v1/state`, { method: "POST" })).status, 405);
      const refresh = await fetch(`http://127.0.0.1:${port}/api/v1/refresh`, { method: "POST" });
      assert.equal(refresh.status, 202);
      const html = await (await fetch(`http://127.0.0.1:${port}/`)).text();
      assert.match(html, /Symphony/);
      assert.match(logs, /issue_identifier=DYL-1/);
      assert.match(logs, /session_id=sess-123-turn-1/);
    } finally {
      const code =
        child.exitCode !== null
          ? child.exitCode
          : await new Promise<number | null>((r) => {
              child.on("close", (c) => r(c));
              child.kill("SIGINT");
            });
      linear.server.close();
      if (process.platform !== "win32") assert.equal(code, 0, logs.slice(-3000));
    }
  });
});
