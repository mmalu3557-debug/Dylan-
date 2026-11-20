import crypto from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import type { Logger } from "../log.js";
import type { Issue, TrackerAdapter } from "../tracker/types.js";

/**
 * Host-side MCP server (Streamable HTTP, JSON responses) that exposes the tracker adapter's
 * provider-native tools to Claude Code (SPEC 10.5 optional extension).
 *
 * Each agent session gets its own unguessable URL bound to one adapter snapshot and the current
 * issue. Tool calls execute in the Symphony process with Symphony's credentials, so the coding
 * agent never receives the raw tracker token.
 */

interface ToolSession {
  adapter: TrackerAdapter;
  getIssue: () => Issue;
  logger: Logger;
}

interface JsonRpcRequest {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: any;
}

const SERVER_NAME = "symphony";
const SERVER_VERSION = "0.1.0";

export class ToolServer {
  private server: http.Server | null = null;
  private port = 0;
  private readonly sessions = new Map<string, ToolSession>();

  constructor(private readonly logger: Logger) {}

  async start(): Promise<void> {
    if (this.server) return;
    const server = http.createServer((req, res) => {
      this.handle(req, res).catch((err) => {
        this.logger.error("tool server request failed", { reason: (err as Error).message });
        if (!res.headersSent) res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "internal error" }));
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => resolve());
    });
    this.server = server;
    this.port = (server.address() as AddressInfo).port;
  }

  async stop(): Promise<void> {
    const s = this.server;
    this.server = null;
    if (!s) return;
    s.closeAllConnections?.();
    await new Promise<void>((resolve) => s.close(() => resolve()));
  }

  /** Registers a session and returns its MCP endpoint URL. */
  register(session: ToolSession): { url: string; token: string } {
    if (!this.server) throw new Error("tool server not started");
    const token = crypto.randomBytes(24).toString("hex");
    this.sessions.set(token, session);
    return { url: `http://127.0.0.1:${this.port}/mcp/${token}`, token };
  }

  unregister(token: string): void {
    this.sessions.delete(token);
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const m = /^\/mcp\/([a-f0-9]+)\/?$/.exec(req.url ?? "");
    const session = m ? this.sessions.get(m[1]) : undefined;
    if (!session) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "unknown session" }));
      return;
    }
    if (req.method === "DELETE") {
      res.writeHead(200).end();
      return;
    }
    if (req.method !== "POST") {
      res.writeHead(405, { Allow: "POST, DELETE" }).end();
      return;
    }
    const body = await readBody(req, 5 * 1024 * 1024);
    let payload: unknown;
    try {
      payload = JSON.parse(body);
    } catch {
      sendJson(res, 400, rpcError(null, -32700, "Parse error"));
      return;
    }
    const batch = Array.isArray(payload);
    const requests = (batch ? payload : [payload]) as JsonRpcRequest[];
    const responses: unknown[] = [];
    for (const r of requests) {
      const out = await this.dispatch(r, session);
      if (out !== null) responses.push(out);
    }
    if (responses.length === 0) {
      res.writeHead(202).end();
      return;
    }
    sendJson(res, 200, batch ? responses : responses[0]);
  }

  private async dispatch(r: JsonRpcRequest, session: ToolSession): Promise<unknown | null> {
    const isNotification = r.id === undefined || r.id === null;
    const id = r.id ?? null;
    switch (r.method) {
      case "initialize":
        return {
          jsonrpc: "2.0",
          id,
          result: {
            protocolVersion: typeof r.params?.protocolVersion === "string" ? r.params.protocolVersion : "2025-06-18",
            capabilities: { tools: { listChanged: false } },
            serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
            instructions: "Tools for the issue tracker of the issue you are working on.",
          },
        };
      case "ping":
        return isNotification ? null : { jsonrpc: "2.0", id, result: {} };
      case "tools/list":
        return {
          jsonrpc: "2.0",
          id,
          result: {
            tools: session.adapter.agentToolSpecs().map((t) => ({
              name: t.name,
              description: t.description,
              inputSchema: t.inputSchema,
              annotations: { readOnlyHint: !t.mutates },
            })),
          },
        };
      case "tools/call": {
        const name = r.params?.name;
        const args = r.params?.arguments ?? {};
        const known = session.adapter.agentToolSpecs().some((t) => t.name === name);
        const issue = session.getIssue();
        const log = session.logger.child({ tool: String(name) });
        let result;
        if (!known) {
          result = { ok: false as const, error: { category: "unsupported_tool", message: `unsupported tool: ${String(name)}` } };
          log.warn("unsupported tool call");
        } else {
          result = await session.adapter.executeAgentTool(String(name), args, { issue });
          log.info(result.ok ? "tool call completed" : "tool call failed", result.ok ? {} : { reason: result.error.message });
        }
        const payload = result.ok ? result.output : { error: result.error };
        return {
          jsonrpc: "2.0",
          id,
          result: { content: [{ type: "text", text: JSON.stringify(payload) }], isError: !result.ok },
        };
      }
      default:
        if (isNotification) return null; // notifications/initialized etc.
        return rpcError(id, -32601, `Method not found: ${String(r.method)}`);
    }
  }
}

function rpcError(id: unknown, code: number, message: string) {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

function readBody(req: http.IncomingMessage, limit: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > limit) {
        reject(new Error("request body too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}
