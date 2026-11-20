import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Logger, MemorySink } from "../src/log.js";
import type { Issue } from "../src/tracker/types.js";

export const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");

export function tmpDir(prefix = "symphony-test-"): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export function memLogger(): { logger: Logger; sink: MemorySink } {
  const sink = new MemorySink();
  return { logger: new Logger([sink], { minLevel: "debug" }), sink };
}

export function makeIssue(over: Partial<Issue> = {}): Issue {
  return {
    id: "id-1",
    native_ref: null,
    identifier: "ABC-1",
    title: "Do the thing",
    description: "desc",
    priority: 2,
    state: "Todo",
    branch_name: null,
    url: "https://linear.app/x/issue/ABC-1",
    assignee_id: null,
    labels: [],
    blocked_by: [],
    dispatchable: true,
    created_at: new Date("2026-01-01T00:00:00Z"),
    updated_at: null,
    ...over,
  };
}

/** Creates a platform-appropriate launcher for the fake Claude CLI and returns its path. */
export function fakeClaudeCommand(dir: string): string {
  const script = path.join(FIXTURES, "fake-claude.mjs");
  if (process.platform === "win32") {
    const p = path.join(dir, "fake-claude.cmd");
    fs.writeFileSync(p, `@"${process.execPath}" "${script}" %*\r\n`);
    return p;
  }
  const p = path.join(dir, "fake-claude");
  fs.writeFileSync(p, `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`);
  fs.chmodSync(p, 0o755);
  return p;
}

export function writeWorkflow(dir: string, frontMatter: string, body = "Work on {{ issue.identifier }}."): string {
  const p = path.join(dir, "WORKFLOW.md");
  fs.writeFileSync(p, `---\n${frontMatter}\n---\n${body}\n`);
  return p;
}

export async function waitFor(cond: () => boolean, timeoutMs = 5000, stepMs = 20): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, stepMs));
  }
}
