import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { buildServiceConfig, expandPath, resolveEnvReference } from "../src/config.js";
import { SymphonyError } from "../src/errors.js";
import { renderPrompt } from "../src/template.js";
import { loadWorkflow, parseWorkflow } from "../src/workflow.js";
import { makeIssue, tmpDir, writeWorkflow } from "./helpers.js";

describe("workflow loader", () => {
  it("splits front matter and trims the body", () => {
    const wf = parseWorkflow("---\ntracker:\n  kind: linear\n---\n\n  Hello {{ issue.title }}  \n");
    assert.deepEqual(wf.config, { tracker: { kind: "linear" } });
    assert.equal(wf.prompt_template, "Hello {{ issue.title }}");
  });

  it("treats a file without front matter as prompt only", () => {
    const wf = parseWorkflow("Just a prompt\n");
    assert.deepEqual(wf.config, {});
    assert.equal(wf.prompt_template, "Just a prompt");
  });

  it("handles BOM and CRLF (Windows editors)", () => {
    const wf = parseWorkflow("\uFEFF---\r\npolling:\r\n  interval_ms: 5\r\n---\r\nBody\r\n");
    assert.deepEqual(wf.config, { polling: { interval_ms: 5 } });
    assert.equal(wf.prompt_template, "Body");
  });

  it("rejects non-map front matter", () => {
    assert.throws(() => parseWorkflow("---\n- a\n- b\n---\nx"), (e: SymphonyError) => e.code === "workflow_front_matter_not_a_map");
  });

  it("rejects invalid YAML", () => {
    assert.throws(() => parseWorkflow("---\na: [1, 2\n---\nx"), (e: SymphonyError) => e.code === "workflow_parse_error");
  });

  it("returns missing_workflow_file for a missing file", () => {
    assert.throws(() => loadWorkflow(path.join(tmpDir(), "nope.md")), (e: SymphonyError) => e.code === "missing_workflow_file");
  });

  it("loads from an explicit path", () => {
    const dir = tmpDir();
    const p = writeWorkflow(dir, "tracker:\n  kind: linear");
    assert.equal(loadWorkflow(p).config.tracker && (loadWorkflow(p).config.tracker as any).kind, "linear");
  });
});

describe("config layer", () => {
  it("applies defaults", () => {
    const { config, errors } = buildServiceConfig({ config: {}, prompt_template: "" }, "/x/WORKFLOW.md");
    assert.deepEqual(errors, []);
    assert.equal(config.polling.interval_ms, 30000);
    assert.equal(config.workspace.root, path.join(os.tmpdir(), "symphony_workspaces"));
    assert.equal(config.hooks.timeout_ms, 60000);
    assert.equal(config.agent.max_concurrent_agents, 10);
    assert.equal(config.agent.max_turns, 20);
    assert.equal(config.agent.max_retry_backoff_ms, 300000);
    assert.equal(config.claude.command, "claude");
    assert.equal(config.claude.turn_timeout_ms, 3600000);
    assert.equal(config.claude.read_timeout_ms, 5000);
    assert.equal(config.claude.stall_timeout_ms, 300000);
    assert.equal(config.server.port, null);
    assert.deepEqual(config.tracker.provider, {});
  });

  it("resolves relative workspace roots against the workflow directory and expands ~ and $VAR", () => {
    const wfPath = path.join(os.tmpdir(), "wfdir", "WORKFLOW.md");
    const rel = buildServiceConfig({ config: { workspace: { root: "ws" } }, prompt_template: "" }, wfPath).config;
    assert.equal(rel.workspace.root, path.join(os.tmpdir(), "wfdir", "ws"));
    const tilde = buildServiceConfig({ config: { workspace: { root: "~/ws" } }, prompt_template: "" }, wfPath).config;
    assert.equal(tilde.workspace.root, path.join(os.homedir(), "ws"));
    const env = buildServiceConfig({ config: { workspace: { root: "$WSROOT/sub" } }, prompt_template: "" }, wfPath, {
      env: { WSROOT: path.join(os.tmpdir(), "envroot") },
    }).config;
    assert.equal(env.workspace.root, path.join(os.tmpdir(), "envroot", "sub"));
  });

  it("expands Windows %VAR% paths", () => {
    assert.equal(expandPath("%USERPROFILE%\\ws", { USERPROFILE: "C:\\Users\\me" }), "C:\\Users\\me\\ws");
  });

  it("resolves $VAR references and treats unset as empty", () => {
    assert.equal(resolveEnvReference("$FOO", { FOO: "bar" }), "bar");
    assert.equal(resolveEnvReference("${FOO}", { FOO: "bar" }), "bar");
    assert.equal(resolveEnvReference("$MISSING", {}), "");
    assert.equal(resolveEnvReference("literal", {}), undefined);
  });

  it("preserves adapter-owned provider keys and the command string", () => {
    const { config } = buildServiceConfig(
      { config: { tracker: { kind: "linear", provider: { project_slug: "abc", custom: { x: 1 } } }, claude: { command: "my claude --flag" } }, prompt_template: "" },
      "/x/WORKFLOW.md",
    );
    assert.deepEqual(config.tracker.provider, { project_slug: "abc", custom: { x: 1 } });
    assert.equal(config.claude.command, "my claude --flag");
  });

  it("normalizes per-state limits and ignores invalid entries", () => {
    const { config, errors } = buildServiceConfig(
      { config: { agent: { max_concurrent_agents_by_state: { " In Progress ": 2, Todo: 0, Bad: "x", Ok: "3" } } }, prompt_template: "" },
      "/x/WORKFLOW.md",
    );
    assert.deepEqual(errors, []);
    assert.deepEqual(config.agent.max_concurrent_agents_by_state, { "in progress": 2, ok: 3 });
  });

  it("reports invalid integers", () => {
    const { errors } = buildServiceConfig({ config: { hooks: { timeout_ms: "soon" }, agent: { max_turns: 0 } }, prompt_template: "" }, "/x/WORKFLOW.md");
    assert.equal(errors.length, 2);
  });

  it("accepts the codex section as a fallback for agent settings", () => {
    const { config } = buildServiceConfig({ config: { codex: { stall_timeout_ms: 0 }, claude: { model: "opus" } }, prompt_template: "" }, "/x/WORKFLOW.md");
    assert.equal(config.claude.stall_timeout_ms, 0);
    assert.equal(config.claude.model, "opus");
  });

  it("CLI port overrides server.port", () => {
    const { config } = buildServiceConfig({ config: { server: { port: 4000 } }, prompt_template: "" }, "/x/WORKFLOW.md", { portOverride: 0 });
    assert.equal(config.server.port, 0);
  });
});

describe("prompt template", () => {
  it("renders issue fields and attempt", async () => {
    const issue = makeIssue({ labels: ["a", "b"] });
    const out = await renderPrompt("{{ issue.identifier }} {{ issue.title }} {% for l in issue.labels %}[{{ l }}]{% endfor %} {% if attempt %}retry {{ attempt }}{% else %}first{% endif %}", issue, null);
    assert.equal(out, "ABC-1 Do the thing [a][b] first");
    assert.equal(await renderPrompt("{{ attempt }}", issue, 3), "3");
  });

  it("fails on unknown variables", async () => {
    await assert.rejects(renderPrompt("{{ nope }}", makeIssue(), null), (e: SymphonyError) => e.code === "template_render_error");
    await assert.rejects(renderPrompt("{{ issue.nope }}", makeIssue(), null), (e: SymphonyError) => e.code === "template_render_error");
  });

  it("fails on unknown filters", async () => {
    await assert.rejects(renderPrompt("{{ issue.title | shout }}", makeIssue(), null), (e: SymphonyError) =>
      ["template_parse_error", "template_render_error"].includes(e.code),
    );
  });

  it("uses a default prompt when the body is empty", async () => {
    assert.match(await renderPrompt("", makeIssue(), null), /working on an issue/);
  });
});

describe("repository WORKFLOW.md", () => {
  it("parses, builds a valid config and renders for first and retry attempts", async () => {
    const wfPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "WORKFLOW.md");
    const def = loadWorkflow(wfPath);
    const { config, errors } = buildServiceConfig(def, wfPath);
    assert.deepEqual(errors, []);
    assert.equal(config.tracker.kind, "linear");
    assert.equal(config.server.port, 4000);
    const first = await renderPrompt(def.prompt_template, makeIssue({ description: null, branch_name: null }), null);
    assert.match(first, /ABC-1/);
    assert.doesNotMatch(first, /tentativa/);
    const retry = await renderPrompt(def.prompt_template, makeIssue({ labels: ["x"] }), 2);
    assert.match(retry, /continuação nº 2/);
  });
});
