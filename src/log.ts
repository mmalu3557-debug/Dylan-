import fs from "node:fs";
import path from "node:path";

export type LogLevel = "debug" | "info" | "warn" | "error";
export type LogFields = Record<string, unknown>;

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface LogSink {
  name: string;
  write(line: string): void;
}

/** Formats one value for stable `key=value` output. Strings with spaces/quotes are JSON-quoted. */
export function formatValue(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string") {
    return /^[^\s"=]+$/.test(value) && value.length > 0 ? value : JSON.stringify(value);
  }
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  try {
    return JSON.stringify(JSON.stringify(value));
  } catch {
    return '"[unserializable]"';
  }
}

export function formatLine(level: LogLevel, msg: string, fields: LogFields): string {
  const parts = [`ts=${new Date().toISOString()}`, `level=${level}`, `msg=${formatValue(msg)}`];
  for (const [k, v] of Object.entries(fields)) {
    if (v === undefined) continue;
    parts.push(`${k}=${formatValue(v)}`);
  }
  return parts.join(" ");
}

export class StderrSink implements LogSink {
  name = "stderr";
  write(line: string): void {
    process.stderr.write(line + "\n");
  }
}

export class FileSink implements LogSink {
  name: string;
  constructor(private readonly filePath: string) {
    this.name = `file:${filePath}`;
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
  }
  write(line: string): void {
    fs.appendFileSync(this.filePath, line + "\n", "utf8");
  }
}

export class MemorySink implements LogSink {
  name = "memory";
  lines: string[] = [];
  write(line: string): void {
    this.lines.push(line);
  }
}

/**
 * Structured key=value logger. A failing sink is disabled (with a warning through the
 * remaining sinks) instead of crashing the orchestrator (SPEC 13.2).
 */
export class Logger {
  private readonly sinks: LogSink[];
  private readonly context: LogFields;
  private readonly minLevel: LogLevel;

  constructor(sinks: LogSink[], opts: { context?: LogFields; minLevel?: LogLevel } = {}) {
    this.sinks = sinks;
    this.context = opts.context ?? {};
    this.minLevel = opts.minLevel ?? "info";
  }

  child(context: LogFields): Logger {
    const l = new Logger(this.sinks, { context: { ...this.context, ...context }, minLevel: this.minLevel });
    return l;
  }

  debug(msg: string, fields: LogFields = {}): void {
    this.log("debug", msg, fields);
  }
  info(msg: string, fields: LogFields = {}): void {
    this.log("info", msg, fields);
  }
  warn(msg: string, fields: LogFields = {}): void {
    this.log("warn", msg, fields);
  }
  error(msg: string, fields: LogFields = {}): void {
    this.log("error", msg, fields);
  }

  log(level: LogLevel, msg: string, fields: LogFields = {}): void {
    if (LEVEL_ORDER[level] < LEVEL_ORDER[this.minLevel]) return;
    const line = formatLine(level, msg, { ...this.context, ...fields });
    const failed: LogSink[] = [];
    for (const sink of this.sinks) {
      try {
        sink.write(line);
      } catch {
        failed.push(sink);
      }
    }
    for (const sink of failed) {
      const idx = this.sinks.indexOf(sink);
      if (idx >= 0) this.sinks.splice(idx, 1);
      const warn = formatLine("warn", "log sink failed; disabled", { sink: sink.name });
      for (const s of this.sinks) {
        try {
          s.write(warn);
        } catch {
          /* ignore */
        }
      }
    }
  }
}

export function truncate(text: string, max = 2000): string {
  if (text.length <= max) return text;
  return text.slice(0, max) + `…[truncated ${text.length - max} chars]`;
}
