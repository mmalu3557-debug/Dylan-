import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { buildServiceConfig, type ServiceConfig } from "../src/config.js";
import { SymphonyError } from "../src/errors.js";
import { isInside, WorkspaceManager, workspaceKey, workspacePathFor } from "../src/workspace.js";
import { memLogger, tmpDir } from "./helpers.js";

const isWin = process.platform === "win32";

function cfg(root: string, hooks: Record<string, unknown> = {}): ServiceConfig {
  return buildServiceConfig({ config: { workspace: { root }, hooks: { shell: isWin ? "powershell" : "sh", ...hooks } }, prompt_template: "" }, path.join(root, "WORKFLOW.md")).config;
}

describe("workspace keys", () => {
  it("keeps safe identifiers unchanged", () => {
    assert.equal(workspaceKey("ABC-123"), "ABC-123");
    assert.equal(workspaceKey("a.b_c-1"), "a.b_c-1");
  });

  it("sanitizes and appends a stable 64-bit hash", () => {
    const k = workspaceKey("ABC/123");
    assert.match(k, /^ABC_123-[0-9a-f]{16}$/);
    assert.equal(workspaceKey("ABC/123"), k);
  });

  it("keeps distinct identifiers that sanitize to the same text distinct", () => {
    assert.notEqual(workspaceKey("a/b"), workspaceKey("a:b"));
    assert.notEqual(workspaceKey("a/b"), "a_b");
  });

  it("never yields traversal or reserved names", () => {
    for (const id of [".", "..", "CON", "nul.txt", "x."]) {
      const k = workspaceKey(id);
      assert.notEqual(k, id);
      assert.match(k, /^[A-Za-z0-9._-]+$/);
    }
  });

  it("enforces root containment", () => {
    const root = tmpDir();
    assert.ok(isInside(root, path.join(root, "x")));
    assert.ok(!isInside(root, root));
    assert.ok(!isInside(root, path.join(root, "..", "x")));
    assert.equal(workspacePathFor(root, "ABC-1").path, path.join(root, "ABC-1"));
  });
});

describe("workspace manager", () => {
  it("creates, reuses, and runs after_create only once", async () => {
    const root = tmpDir();
    const hook = isWin ? "Add-Content -Path count.txt -Value x" : "echo x >> count.txt";
    const c = cfg(root, { after_create: hook });
    const { logger } = memLogger();
    const wm = new WorkspaceManager(() => c, logger);
    const a = await wm.createForIssue({ issue_identifier: "ABC-1" });
    assert.equal(a.created_now, true);
    const b = await wm.createForIssue({ issue_identifier: "ABC-1" });
    assert.equal(b.created_now, false);
    assert.equal(a.path, b.path);
    assert.equal(fs.readFileSync(path.join(a.path, "count.txt"), "utf8").trim().split(/\r?\n/).length, 1);
  });

  it("aborts creation and removes the directory when after_create fails", async () => {
    const root = tmpDir();
    const c = cfg(root, { after_create: "exit 7" });
    const wm = new WorkspaceManager(() => c, memLogger().logger);
    await assert.rejects(wm.createForIssue({ issue_identifier: "ABC-2" }), (e: SymphonyError) => e.code === "hook_failed");
    assert.equal(fs.existsSync(path.join(root, "ABC-2")), false);
  });

  it("fails safely when a non-directory occupies the workspace path", async () => {
    const root = tmpDir();
    fs.writeFileSync(path.join(root, "ABC-3"), "file");
    const wm = new WorkspaceManager(() => cfg(root), memLogger().logger);
    await assert.rejects(wm.createForIssue({ issue_identifier: "ABC-3" }), (e: SymphonyError) => e.code === "workspace_path_not_directory");
  });

  it("reports before_run failure and timeouts", async () => {
    const root = tmpDir();
    const c = cfg(root, { before_run: isWin ? "Start-Sleep -Seconds 5" : "sleep 5", timeout_ms: 300 });
    const { logger, sink } = memLogger();
    const wm = new WorkspaceManager(() => c, logger);
    const ws = await wm.createForIssue({ issue_identifier: "ABC-4" });
    const started = Date.now();
    assert.equal(await wm.runHook("before_run", ws.path, { issue_identifier: "ABC-4" }), false);
    assert.ok(Date.now() - started < 4000);
    assert.ok(sink.lines.some((l) => l.includes("hook timed out")));
  });

  it("runs before_remove, ignores its failure, and removes the workspace", async () => {
    const root = tmpDir();
    const c = cfg(root, { before_remove: "exit 1" });
    const wm = new WorkspaceManager(() => c, memLogger().logger);
    const ws = await wm.createForIssue({ issue_identifier: "ABC-5" });
    fs.writeFileSync(path.join(ws.path, "f.txt"), "x");
    assert.equal(await wm.removeForIssue({ issue_identifier: "ABC-5" }), true);
    assert.equal(fs.existsSync(ws.path), false);
  });
});
