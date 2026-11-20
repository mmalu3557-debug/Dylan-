import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { HookName, ServiceConfig } from "./config.js";
import { SymphonyError } from "./errors.js";
import { runShellScript } from "./hooks.js";
import type { Logger } from "./log.js";
import { truncate } from "./log.js";

export interface Workspace {
  path: string;
  workspace_key: string;
  created_now: boolean;
}

const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i;

/**
 * Derives the workspace directory name from an issue identifier (SPEC 4.2 / 9.5).
 * Characters outside `[A-Za-z0-9._-]` become `_`. When sanitization changes the identifier — or
 * the result would be unsafe as a directory name (`.`, `..`, Windows reserved names, trailing
 * dot) — a 64-bit hex hash of the original identifier is appended.
 */
export function workspaceKey(identifier: string): string {
  const sanitized = identifier.replace(/[^A-Za-z0-9._-]/g, "_");
  const unsafe =
    sanitized === "" || sanitized === "." || sanitized === ".." || WINDOWS_RESERVED.test(sanitized) || sanitized.endsWith(".");
  if (sanitized === identifier && !unsafe) return sanitized;
  const hash = crypto.createHash("sha256").update(identifier, "utf8").digest("hex").slice(0, 16);
  return `${sanitized}-${hash}`;
}

/** True when `child` is strictly inside `root` (both normalized to absolute paths). */
export function isInside(root: string, child: string): boolean {
  const rel = path.relative(path.resolve(root), path.resolve(child));
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

export function workspacePathFor(root: string, identifier: string): { key: string; path: string } {
  const key = workspaceKey(identifier);
  const absRoot = path.resolve(root);
  const p = path.join(absRoot, key);
  if (!isInside(absRoot, p)) {
    throw new SymphonyError("invalid_workspace_path", `workspace path ${p} escapes workspace root ${absRoot}`);
  }
  return { key, path: p };
}

/** Re-checks containment using real paths (defends against symlinks/junctions). */
export function assertWorkspaceSafe(root: string, workspacePath: string): void {
  let realRoot = path.resolve(root);
  let realWs = path.resolve(workspacePath);
  try {
    realRoot = fs.realpathSync.native(realRoot);
    realWs = fs.realpathSync.native(realWs);
  } catch {
    /* fall back to lexical check */
  }
  if (!isInside(realRoot, realWs)) {
    throw new SymphonyError("invalid_workspace_cwd", `workspace ${workspacePath} is not inside workspace root ${root}`);
  }
}

export interface HookContext {
  issue_id?: string;
  issue_identifier: string;
}

export class WorkspaceManager {
  constructor(
    private readonly getConfig: () => ServiceConfig,
    private readonly logger: Logger,
    private readonly hookEnv: () => NodeJS.ProcessEnv = () => process.env,
  ) {}

  pathFor(identifier: string): { key: string; path: string } {
    return workspacePathFor(this.getConfig().workspace.root, identifier);
  }

  async createForIssue(ctx: HookContext): Promise<Workspace> {
    const cfg = this.getConfig();
    const root = path.resolve(cfg.workspace.root);
    const { key, path: wsPath } = workspacePathFor(root, ctx.issue_identifier);
    try {
      fs.mkdirSync(root, { recursive: true });
    } catch (err) {
      throw new SymphonyError("workspace_create_failed", `cannot create workspace root ${root}: ${(err as Error).message}`);
    }

    let createdNow = false;
    let st: fs.Stats | null = null;
    try {
      st = fs.lstatSync(wsPath);
    } catch {
      st = null;
    }
    if (st && !st.isDirectory()) {
      // Policy: never delete an unexpected non-directory entry; fail the attempt instead.
      throw new SymphonyError("workspace_path_not_directory", `workspace path ${wsPath} exists and is not a directory`);
    }
    if (!st) {
      try {
        fs.mkdirSync(wsPath);
        createdNow = true;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "EEXIST") {
          throw new SymphonyError("workspace_create_failed", `cannot create workspace ${wsPath}: ${(err as Error).message}`);
        }
      }
    }
    assertWorkspaceSafe(root, wsPath);

    if (createdNow && cfg.hooks.after_create) {
      const ok = await this.runHook("after_create", wsPath, ctx);
      if (!ok) {
        // Remove the partially prepared brand-new directory so the next attempt starts clean.
        try {
          fs.rmSync(wsPath, { recursive: true, force: true, maxRetries: 3 });
        } catch {
          /* ignore */
        }
        throw new SymphonyError("hook_failed", "after_create hook failed; workspace creation aborted");
      }
    }
    return { path: wsPath, workspace_key: key, created_now: createdNow };
  }

  /** Runs a hook in the workspace. Returns true on success (or when the hook is not configured). */
  async runHook(name: HookName, wsPath: string, ctx: HookContext): Promise<boolean> {
    const cfg = this.getConfig();
    const script = cfg.hooks[name];
    if (!script) return true;
    const log = this.logger.child({ issue_id: ctx.issue_id, issue_identifier: ctx.issue_identifier, hook: name });
    log.info("hook started", { cwd: wsPath, shell: cfg.hooks.shell });
    const started = Date.now();
    const res = await runShellScript(script, {
      cwd: wsPath,
      timeoutMs: cfg.hooks.timeout_ms,
      shell: cfg.hooks.shell,
      env: {
        ...this.hookEnv(),
        SYMPHONY_ISSUE_ID: ctx.issue_id ?? "",
        SYMPHONY_ISSUE_IDENTIFIER: ctx.issue_identifier,
        SYMPHONY_WORKSPACE: wsPath,
      },
    });
    const duration_ms = Date.now() - started;
    if (res.ok) {
      log.info("hook completed", { duration_ms });
      return true;
    }
    log.warn(res.timedOut ? "hook timed out" : "hook failed", {
      duration_ms,
      exit_code: res.exitCode,
      reason: res.error,
      output: truncate(res.output.trim(), 2000),
    });
    return false;
  }

  /** Removes the workspace for an identifier, running `before_remove` first (failures ignored). */
  async removeForIssue(ctx: HookContext): Promise<boolean> {
    const cfg = this.getConfig();
    let wsPath: string;
    try {
      wsPath = workspacePathFor(cfg.workspace.root, ctx.issue_identifier).path;
    } catch (err) {
      this.logger.warn("workspace cleanup skipped", { issue_identifier: ctx.issue_identifier, reason: (err as Error).message });
      return false;
    }
    let st: fs.Stats;
    try {
      st = fs.lstatSync(wsPath);
    } catch {
      return false;
    }
    if (st.isDirectory()) {
      await this.runHook("before_remove", wsPath, ctx);
    }
    try {
      fs.rmSync(wsPath, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
      this.logger.info("workspace removed", { issue_id: ctx.issue_id, issue_identifier: ctx.issue_identifier, path: wsPath });
      return true;
    } catch (err) {
      this.logger.warn("workspace removal failed", {
        issue_id: ctx.issue_id,
        issue_identifier: ctx.issue_identifier,
        path: wsPath,
        reason: (err as Error).message,
      });
      return false;
    }
  }
}
