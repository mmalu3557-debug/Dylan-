import type { ServiceConfig } from "../config.js";
import type { Logger } from "../log.js";
import { linearFactory } from "./linear.js";
import type { TrackerFactory } from "./types.js";

export type TrackerRegistry = Map<string, TrackerFactory>;

export function defaultTrackerRegistry(logger?: Logger): TrackerRegistry {
  const reg: TrackerRegistry = new Map();
  const linear = linearFactory(logger);
  reg.set(linear.kind, linear);
  return reg;
}

export function effectiveStates(
  config: ServiceConfig,
  factory: TrackerFactory | undefined,
): { active_states: string[]; terminal_states: string[] } {
  return {
    active_states: config.tracker.active_states ?? factory?.defaultActiveStates ?? [],
    terminal_states: config.tracker.terminal_states ?? factory?.defaultTerminalStates ?? [],
  };
}
