import fs from "node:fs";
import YAML from "yaml";
import { SymphonyError } from "./errors.js";

export interface WorkflowDefinition {
  /** YAML front matter root object. */
  config: Record<string, unknown>;
  /** Markdown body after the front matter, trimmed. */
  prompt_template: string;
}

/**
 * Parses WORKFLOW.md text (SPEC 5.2). Handles a UTF-8 BOM and CRLF line endings, which are
 * common when the file is edited on Windows.
 */
export function parseWorkflow(text: string): WorkflowDefinition {
  const normalized = text.replace(/^﻿/, "").replace(/\r\n?/g, "\n");
  const lines = normalized.split("\n");

  if (lines[0]?.trim() !== "---") {
    return { config: {}, prompt_template: normalized.trim() };
  }

  let end = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === "---") {
      end = i;
      break;
    }
  }
  if (end < 0) {
    throw new SymphonyError("workflow_parse_error", "front matter starts with '---' but has no closing '---' line");
  }

  const yamlText = lines.slice(1, end).join("\n");
  const body = lines.slice(end + 1).join("\n");

  let parsed: unknown;
  try {
    const doc = YAML.parseDocument(yamlText);
    if (doc.errors.length > 0) {
      throw doc.errors[0];
    }
    parsed = doc.toJS();
  } catch (err) {
    throw new SymphonyError("workflow_parse_error", `invalid YAML front matter: ${(err as Error).message}`);
  }

  if (parsed === null || parsed === undefined) {
    parsed = {};
  }
  if (typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new SymphonyError("workflow_front_matter_not_a_map", "YAML front matter must decode to a map/object");
  }

  return { config: parsed as Record<string, unknown>, prompt_template: body.trim() };
}

export function loadWorkflow(filePath: string): WorkflowDefinition {
  let text: string;
  try {
    text = fs.readFileSync(filePath, "utf8");
  } catch (err) {
    throw new SymphonyError("missing_workflow_file", `cannot read workflow file ${filePath}: ${(err as Error).message}`);
  }
  return parseWorkflow(text);
}
