import { Liquid } from "liquidjs";
import { SymphonyError } from "./errors.js";
import type { Issue } from "./tracker/types.js";

const engine = new Liquid({
  strictVariables: true,
  strictFilters: true,
  ownPropertyOnly: true,
  cache: false,
});

export const DEFAULT_PROMPT = "You are working on an issue from the configured tracker.";

/** Converts an issue into a template-friendly plain object (string keys, ISO timestamps). */
export function issueToTemplateObject(issue: Issue): Record<string, unknown> {
  return JSON.parse(
    JSON.stringify(issue, (_k, v) => (v instanceof Date ? v.toISOString() : v)),
  ) as Record<string, unknown>;
}

/**
 * Renders the WORKFLOW.md prompt body with strict variable/filter checking (SPEC 5.4, 12.2).
 * `attempt` is null on the first run and a 1-based integer on retries/continuations.
 */
export async function renderPrompt(
  template: string,
  issue: Issue,
  attempt: number | null,
  extra: Record<string, unknown> = {},
): Promise<string> {
  const source = template.trim() === "" ? DEFAULT_PROMPT : template;
  let parsed;
  try {
    parsed = engine.parse(source);
  } catch (err) {
    throw new SymphonyError("template_parse_error", (err as Error).message);
  }
  try {
    const out = await engine.render(parsed, { issue: issueToTemplateObject(issue), attempt, ...extra });
    return out.trim();
  } catch (err) {
    throw new SymphonyError("template_render_error", (err as Error).message);
  }
}

/** Parse-only check used by config validation so template typos surface early. */
export function checkTemplateSyntax(template: string): string | null {
  try {
    engine.parse(template);
    return null;
  } catch (err) {
    return (err as Error).message;
  }
}
