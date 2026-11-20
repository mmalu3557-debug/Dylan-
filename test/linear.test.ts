import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { LinearAdapter, linearFactory, resolveLinearSettings, slugFromProjectUrl, type LinearSettings } from "../src/tracker/linear.js";
import { TrackerError } from "../src/tracker/types.js";
import { memLogger } from "./helpers.js";

const settings: LinearSettings = {
  apiKey: "lin_api_test",
  apiKeyEnvName: "LINEAR_API_KEY",
  endpoint: "https://linear.test/graphql",
  projectSlug: "abc123",
  assignee: null,
  blockerGatedStates: ["Todo"],
  pageSize: 2,
  timeoutMs: 1000,
};
const states = { active_states: ["Todo", "In Progress"], terminal_states: ["Done", "Canceled"] };

function node(over: Record<string, unknown> = {}) {
  return {
    id: "uuid-1",
    identifier: "ABC-1",
    title: "Title",
    description: null,
    priority: 2,
    url: "https://linear.app/x/issue/ABC-1",
    branchName: "abc-1-title",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "not a date",
    state: { name: "Todo", type: "unstarted" },
    assignee: null,
    team: { id: "t1", key: "ABC" },
    project: { id: "p1", slugId: "abc123" },
    labels: { nodes: [{ name: " Frontend " }, { name: "frontend" }, { name: "" }] },
    inverseRelations: { nodes: [] },
    ...over,
  };
}

function mockFetch(pages: unknown[]) {
  const calls: any[] = [];
  const fn = (async (_url: string, init: any) => {
    calls.push(JSON.parse(init.body));
    const body = pages[Math.min(calls.length - 1, pages.length - 1)];
    if (body instanceof Response) return body;
    return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
  }) as unknown as typeof fetch;
  return { fn, calls };
}

const page = (nodes: unknown[], hasNextPage = false, endCursor: string | null = null) => ({
  data: { issues: { nodes, pageInfo: { hasNextPage, endCursor } } },
});

describe("linear adapter", () => {
  it("extracts the project slug from a project URL", () => {
    assert.equal(slugFromProjectUrl("https://linear.app/acme/project/area-logada-3f2a9c1b7d4e/overview"), "3f2a9c1b7d4e");
    assert.equal(slugFromProjectUrl("https://linear.app/acme/team/ABC"), null);
  });

  it("validates provider config and secrets", () => {
    const base = { kind: "linear", required_labels: [], active_states: null, terminal_states: null };
    let r = resolveLinearSettings({ ...base, provider: { project_slug: "x" } }, {});
    assert.equal(r.missingSecret, true);
    r = resolveLinearSettings({ ...base, provider: { project_slug: "x" } }, { LINEAR_API_KEY: "k" });
    assert.deepEqual(r.errors, []);
    r = resolveLinearSettings({ ...base, provider: { api_key: "$MY_KEY", project_url: "COLE_AQUI" } }, { MY_KEY: "k" });
    assert.ok(r.errors.some((e) => e.includes("texto de exemplo")));
    r = resolveLinearSettings({ ...base, provider: {} }, { LINEAR_API_KEY: "k" });
    assert.ok(r.errors.some((e) => e.includes("project_slug")));
    const f = linearFactory();
    assert.deepEqual(f.secretEnvironmentNames({ ...base, provider: { api_key: "$MY_KEY" } }), ["LINEAR_API_KEY", "MY_KEY"]);
    assert.throws(() => f.create({ ...base, provider: { project_slug: "x" } }, states, {}), (e: TrackerError) => e.category === "missing_tracker_secret");
  });

  it("returns empty without a request for empty inputs", async () => {
    const { fn, calls } = mockFetch([page([])]);
    const a = new LinearAdapter(settings, states, undefined, fn);
    assert.deepEqual(await a.fetchIssuesByStates([]), []);
    assert.deepEqual(await a.fetchIssuesByIds([]), []);
    assert.equal(calls.length, 0);
  });

  it("paginates in order and applies project scope + states", async () => {
    const { fn, calls } = mockFetch([
      page([node({ id: "1", identifier: "ABC-1" }), node({ id: "2", identifier: "ABC-2" })], true, "c1"),
      page([node({ id: "3", identifier: "ABC-3" })]),
    ]);
    const a = new LinearAdapter(settings, states, undefined, fn);
    const issues = await a.fetchIssuesByStates(["Todo"]);
    assert.deepEqual(issues.map((i) => i.identifier), ["ABC-1", "ABC-2", "ABC-3"]);
    assert.equal(calls[1].variables.after, "c1");
    assert.deepEqual(calls[0].variables.filter, { project: { slugId: { eq: "abc123" } }, state: { name: { in: ["Todo"] } } });
  });

  it("normalizes fields", async () => {
    const { fn } = mockFetch([page([node()])]);
    const [i] = await new LinearAdapter(settings, states, undefined, fn).fetchIssuesByStates(["Todo"]);
    assert.deepEqual(i.labels, ["frontend"]);
    assert.equal(i.priority, 2);
    assert.equal(i.created_at?.toISOString(), "2026-01-01T00:00:00.000Z");
    assert.equal(i.updated_at, null);
    assert.equal(i.description, null);
    assert.equal(i.branch_name, "abc-1-title");
    assert.equal(i.dispatchable, true);
    assert.equal((i.native_ref as any).team_key, "ABC");
  });

  it("derives dispatchable from blockers in gated states", async () => {
    const blocked = node({
      inverseRelations: {
        nodes: [
          { type: "blocks", issue: { id: "b1", identifier: "ABC-9", state: { name: "In Progress", type: "started" } } },
          { type: "related", issue: { id: "b2", identifier: "ABC-8", state: { name: "Todo", type: "unstarted" } } },
        ],
      },
    });
    const resolved = node({
      id: "2",
      identifier: "ABC-2",
      inverseRelations: { nodes: [{ type: "blocks", issue: { id: "b1", identifier: "ABC-9", state: { name: "Done", type: "completed" } } }] },
    });
    const inProgress = node({ id: "3", identifier: "ABC-3", state: { name: "In Progress", type: "started" }, inverseRelations: blocked.inverseRelations });
    const { fn } = mockFetch([page([blocked, resolved, inProgress])]);
    const issues = await new LinearAdapter({ ...settings, pageSize: 50 }, states, undefined, fn).fetchIssuesByStates(["Todo", "In Progress"]);
    assert.deepEqual(issues.map((i) => i.dispatchable), [false, true, true]);
    assert.deepEqual(issues[0].blocked_by, [{ id: "b1", identifier: "ABC-9", state: "In Progress" }]);
  });

  it("omits malformed records from state lists but fails ID refresh", async () => {
    const bad = node({ id: "x", title: "" });
    const { logger, sink } = memLogger();
    const a = new LinearAdapter({ ...settings, pageSize: 50 }, states, logger, mockFetch([page([bad, node()])]).fn);
    assert.equal((await a.fetchIssuesByStates(["Todo"])).length, 1);
    assert.ok(sink.lines.some((l) => l.includes("malformed")));
    const b = new LinearAdapter({ ...settings, pageSize: 50 }, states, logger, mockFetch([page([bad])]).fn);
    await assert.rejects(b.fetchIssuesByIds(["x"]), (e: TrackerError) => e.category === "tracker_response");
  });

  it("maps transport, status, rate limit, payload and pagination errors", async () => {
    const failing = (async () => {
      throw new Error("ECONNRESET");
    }) as unknown as typeof fetch;
    await assert.rejects(new LinearAdapter(settings, states, undefined, failing).fetchIssuesByStates(["Todo"]), (e: TrackerError) => e.category === "tracker_request");
    const cases: Array<[Response | unknown, string]> = [
      [new Response("nope", { status: 500 }), "tracker_status"],
      [new Response("{}", { status: 429 }), "tracker_rate_limited"],
      [{ errors: [{ message: "slow down", extensions: { code: "RATELIMITED" } }] }, "tracker_rate_limited"],
      [{ data: { issues: null } }, "tracker_response"],
      [new Response("<html>", { status: 200 }), "tracker_response"],
      [page([node()], true, null), "tracker_pagination"],
    ];
    for (const [body, category] of cases) {
      const a = new LinearAdapter(settings, states, undefined, mockFetch([body]).fn);
      await assert.rejects(a.fetchIssuesByStates(["Todo"]), (e: TrackerError) => e.category === category, category);
    }
  });

  it("executes the linear_graphql tool host-side and reports structured failures", async () => {
    const { fn, calls } = mockFetch([{ data: { viewer: { id: "u1" } } }]);
    const a = new LinearAdapter(settings, states, undefined, fn);
    const issue = (await new LinearAdapter(settings, states, undefined, mockFetch([page([node()])]).fn).fetchIssuesByStates(["Todo"]))[0];
    assert.deepEqual(await a.executeAgentTool("linear_graphql", { query: "query { viewer { id } }" }, { issue }), { ok: true, output: { data: { viewer: { id: "u1" } } } });
    assert.equal(calls.length, 1);
    const invalid = await a.executeAgentTool("linear_graphql", { query: 5 }, { issue });
    assert.equal(invalid.ok, false);
    const unsupported = await a.executeAgentTool("other", {}, { issue });
    assert.equal(unsupported.ok, false);
    assert.deepEqual(a.secretEnvironmentNames(), ["LINEAR_API_KEY"]);
  });
});
