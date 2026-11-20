import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { buildServiceConfig, type ServiceConfig } from "./config.js";
import { SymphonyError, errorMessage } from "./errors.js";
import type { Logger } from "./log.js";
import { checkTemplateSyntax } from "./template.js";
import type { TrackerRegistry } from "./tracker/index.js";
import { validateDispatchConfig } from "./validation.js";
import { loadWorkflow, type WorkflowDefinition } from "./workflow.js";

export interface EffectiveWorkflow {
  definition: WorkflowDefinition;
  config: ServiceConfig;
  hash: string;
  loaded_at: Date;
}

export interface WorkflowStoreOptions {
  portOverride?: number | null;
  logsRoot?: string | null;
  env?: NodeJS.ProcessEnv;
  /** Disable the agent executable PATH check (tests). */
  checkAgentExecutable?: boolean;
}

/**
 * Owns WORKFLOW.md loading and dynamic reload (SPEC 6.2). Invalid reloads keep the last known
 * good effective configuration and record an operator-visible error.
 */
export class WorkflowStore {
  private current: EffectiveWorkflow | null = null;
  private watcher: fs.FSWatcher | null = null;
  private debounce: NodeJS.Timeout | null = null;
  lastError: string | null = null;
  lastErrorAt: Date | null = null;
  private listeners: Array<(wf: EffectiveWorkflow) => void> = [];

  constructor(
    readonly workflowPath: string,
    private readonly registry: TrackerRegistry,
    private readonly logger: Logger,
    private readonly opts: WorkflowStoreOptions = {},
  ) {}

  get effective(): EffectiveWorkflow {
    if (!this.current) throw new SymphonyError("workflow_not_loaded", "workflow not loaded");
    return this.current;
  }

  get config(): ServiceConfig {
    return this.effective.config;
  }

  onChange(fn: (wf: EffectiveWorkflow) => void): void {
    this.listeners.push(fn);
  }

  /** Loads and validates; throws a typed error on any problem. Does not mutate state. */
  private loadCandidate(): EffectiveWorkflow {
    const text = (() => {
      try {
        return fs.readFileSync(this.workflowPath, "utf8");
      } catch (err) {
        throw new SymphonyError("missing_workflow_file", `cannot read workflow file ${this.workflowPath}: ${errorMessage(err)}`);
      }
    })();
    const hash = crypto.createHash("sha256").update(text).digest("hex");
    const definition = loadWorkflow(this.workflowPath);
    const { config, errors } = buildServiceConfig(definition, this.workflowPath, {
      env: this.opts.env,
      portOverride: this.opts.portOverride,
      logsRoot: this.opts.logsRoot,
    });
    if (errors.length) throw new SymphonyError("invalid_config", errors.join("; "));
    const templateErr = checkTemplateSyntax(definition.prompt_template);
    if (templateErr) throw new SymphonyError("template_parse_error", templateErr);
    const validation = validateDispatchConfig(config, this.registry, this.opts.env, {
      checkAgentExecutable: this.opts.checkAgentExecutable,
    });
    if (validation.length) throw new SymphonyError("invalid_dispatch_config", validation.join("; "));
    return { definition, config, hash, loaded_at: new Date() };
  }

  /** Initial load; throws on failure (startup must fail). */
  loadInitial(): EffectiveWorkflow {
    this.current = this.loadCandidate();
    return this.current;
  }

  /** Re-reads the file if its content changed. Returns true when a new config was applied. */
  reloadIfChanged(): boolean {
    let text: string;
    try {
      text = fs.readFileSync(this.workflowPath, "utf8");
    } catch (err) {
      this.recordError(`cannot read workflow file: ${errorMessage(err)}`);
      return false;
    }
    const hash = crypto.createHash("sha256").update(text).digest("hex");
    if (this.current && hash === this.current.hash) return false;
    try {
      const next = this.loadCandidate();
      this.current = next;
      this.lastError = null;
      this.lastErrorAt = null;
      this.logger.info("workflow reloaded", { path: this.workflowPath });
      for (const l of this.listeners) l(next);
      return true;
    } catch (err) {
      // Avoid logging the same broken content repeatedly.
      const msg = `workflow reload failed; keeping last known good config: ${errorMessage(err)}`;
      if (this.lastError !== msg) this.logger.error(msg, { path: this.workflowPath });
      this.recordError(msg);
      return false;
    }
  }

  private recordError(msg: string): void {
    this.lastError = msg;
    this.lastErrorAt = new Date();
  }

  /** Watches the containing directory (editors often replace the file on save). */
  startWatching(): void {
    if (this.watcher) return;
    const dir = path.dirname(path.resolve(this.workflowPath));
    const base = path.basename(this.workflowPath);
    try {
      this.watcher = fs.watch(dir, (_event, filename) => {
        if (filename && filename.toString() !== base) return;
        if (this.debounce) clearTimeout(this.debounce);
        this.debounce = setTimeout(() => this.reloadIfChanged(), 250);
      });
      this.watcher.on("error", (err) => {
        this.logger.warn("workflow watch error; relying on per-tick reload checks", { reason: err.message });
      });
    } catch (err) {
      this.logger.warn("workflow watch unavailable; relying on per-tick reload checks", { reason: errorMessage(err) });
    }
  }

  stopWatching(): void {
    if (this.debounce) clearTimeout(this.debounce);
    this.watcher?.close();
    this.watcher = null;
  }
}
