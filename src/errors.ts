/** Typed error with a stable `code`/category plus a human-readable message. */
export class SymphonyError extends Error {
  readonly code: string;
  readonly details?: Record<string, unknown>;

  constructor(code: string, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = "SymphonyError";
    this.code = code;
    this.details = details;
  }
}

export function errorCode(err: unknown): string {
  if (err instanceof SymphonyError) return err.code;
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === "string" && code !== "" ? code : "unexpected_error";
}

export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

/** `code: message` summary for logs / retry entries. */
export function describeError(err: unknown): string {
  return `${errorCode(err)}: ${errorMessage(err)}`;
}
