import type { ServiceConfig } from "./config.js";
import { resolveCommand } from "./process.js";
import { effectiveStates, type TrackerRegistry } from "./tracker/index.js";

/**
 * Dispatch preflight validation (SPEC 6.3). Returns operator-facing error strings; an empty
 * list means new work may be dispatched.
 */
export function validateDispatchConfig(
  config: ServiceConfig,
  registry: TrackerRegistry,
  env: NodeJS.ProcessEnv = process.env,
  opts: { checkAgentExecutable?: boolean } = {},
): string[] {
  const errors: string[] = [];
  const kind = config.tracker.kind;
  if (!kind) {
    errors.push("tracker.kind is required (supported: " + [...registry.keys()].join(", ") + ")");
  } else {
    const factory = registry.get(kind);
    if (!factory) {
      errors.push(`unsupported tracker.kind "${kind}" (supported: ${[...registry.keys()].join(", ")})`);
    } else {
      errors.push(...factory.validate(config.tracker, env));
      const states = effectiveStates(config, factory);
      if (states.active_states.length === 0) errors.push("tracker.active_states must not be empty");
    }
  }
  if (!config.claude.command || config.claude.command.trim() === "") {
    errors.push("claude.command must be a non-empty command");
  } else if (opts.checkAgentExecutable !== false && !resolveCommand(config.claude.command, env)) {
    errors.push(
      `coding agent executable not found: "${config.claude.command}" (install Claude Code or set claude.command to its full path)`,
    );
  }
  return errors;
}
