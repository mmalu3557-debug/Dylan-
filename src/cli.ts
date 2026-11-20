#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { ToolServer } from "./agent/toolServer.js";
import { describeError } from "./errors.js";
import { StatusServer } from "./http.js";
import { FileSink, Logger, StderrSink, type LogSink } from "./log.js";
import { Orchestrator } from "./orchestrator.js";
import { scrubEnv } from "./process.js";
import { runAgentAttempt } from "./runner.js";
import { defaultTrackerRegistry } from "./tracker/index.js";
import { WorkflowStore } from "./workflowStore.js";
import { WorkspaceManager } from "./workspace.js";
import { runDoctor } from "./doctor.js";

interface CliArgs {
  command: "run" | "doctor" | "help";
  workflowPath: string | null;
  port: number | null;
  logsRoot: string | null;
  debug: boolean;
}

export function parseArgs(argv: string[]): CliArgs {
  const out: CliArgs = { command: "run", workflowPath: null, port: null, logsRoot: null, debug: false };
  const rest = [...argv];
  if (rest[0] === "doctor") {
    out.command = "doctor";
    rest.shift();
  } else if (rest[0] === "help" || rest[0] === "--help" || rest[0] === "-h") {
    out.command = "help";
    return out;
  }
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === "--port") {
      const v = Number(rest[++i]);
      if (!Number.isInteger(v) || v < 0) throw new Error("--port requires a non-negative integer");
      out.port = v;
    } else if (a.startsWith("--port=")) {
      const v = Number(a.slice(7));
      if (!Number.isInteger(v) || v < 0) throw new Error("--port requires a non-negative integer");
      out.port = v;
    } else if (a === "--logs-root") {
      out.logsRoot = rest[++i] ?? null;
    } else if (a === "--debug") {
      out.debug = true;
    } else if (a.startsWith("-")) {
      throw new Error(`unknown option ${a}`);
    } else if (!out.workflowPath) {
      out.workflowPath = a;
    } else {
      throw new Error(`unexpected argument ${a}`);
    }
  }
  return out;
}

const HELP = `Symphony (Claude Code + Linear)

Uso:
  symphony [caminho/para/WORKFLOW.md] [--port N] [--logs-root DIR] [--debug]
  symphony doctor [caminho/para/WORKFLOW.md]     verifica a instalação e as credenciais

Sem caminho, usa ./WORKFLOW.md.
`;

async function main(argv: string[]): Promise<number> {
  let args: CliArgs;
  try {
    args = parseArgs(argv);
  } catch (err) {
    process.stderr.write(`erro: ${(err as Error).message}\n\n${HELP}`);
    return 2;
  }
  if (args.command === "help") {
    process.stdout.write(HELP);
    return 0;
  }

  const workflowPath = path.resolve(args.workflowPath ?? "WORKFLOW.md");
  if (!fs.existsSync(workflowPath)) {
    process.stderr.write(`erro: arquivo de workflow não encontrado: ${workflowPath}\n`);
    return 1;
  }

  if (args.command === "doctor") return runDoctor(workflowPath);

  const sinks: LogSink[] = [new StderrSink()];
  const logger = new Logger(sinks, { minLevel: args.debug ? "debug" : "info" });
  const registry = defaultTrackerRegistry(logger);
  const store = new WorkflowStore(workflowPath, registry, logger, { portOverride: args.port, logsRoot: args.logsRoot });

  try {
    store.loadInitial();
  } catch (err) {
    logger.error("startup failed: invalid workflow configuration", { reason: describeError(err), path: workflowPath });
    process.stderr.write(`\nDica: rode "npm run doctor" para um diagnóstico passo a passo.\n`);
    return 1;
  }
  const config = store.config;
  try {
    sinks.push(new FileSink(path.join(config.logging.root, "symphony.log")));
  } catch (err) {
    logger.warn("file log sink unavailable", { reason: (err as Error).message });
  }

  const factory = registry.get(config.tracker.kind ?? "");
  const secretNames = factory ? factory.secretEnvironmentNames(config.tracker) : [];
  const workspaces = new WorkspaceManager(() => store.config, logger, () => scrubEnv(process.env, secretNames));
  const toolServer = new ToolServer(logger);
  await toolServer.start();

  const orchestrator = new Orchestrator({
    store,
    registry,
    logger,
    workspaces,
    runAttempt: runAgentAttempt,
    toolServer,
  });

  let statusServer: StatusServer | null = null;
  if (config.server.port !== null) {
    statusServer = new StatusServer(orchestrator, logger);
    try {
      await statusServer.start(config.server.port, config.server.host);
    } catch (err) {
      logger.error("dashboard failed to start; continuing without it", { reason: (err as Error).message });
      statusServer = null;
    }
  }

  store.startWatching();
  logger.info("symphony started", {
    workflow: workflowPath,
    tracker: config.tracker.kind,
    workspace_root: config.workspace.root,
    max_concurrent_agents: config.agent.max_concurrent_agents,
  });
  await orchestrator.start();

  return await new Promise<number>((resolve) => {
    let stopping = false;
    const shutdown = async (signal: string) => {
      if (stopping) {
        logger.warn("forced exit");
        process.exit(130);
      }
      stopping = true;
      logger.info("shutting down", { signal });
      store.stopWatching();
      await orchestrator.stop();
      await statusServer?.stop();
      await toolServer.stop();
      logger.info("symphony stopped");
      resolve(0);
    };
    process.on("SIGINT", () => void shutdown("SIGINT"));
    process.on("SIGTERM", () => void shutdown("SIGTERM"));
    process.on("SIGBREAK", () => void shutdown("SIGBREAK"));
  });
}

process.on("unhandledRejection", (err) => {
  process.stderr.write(`unhandled rejection: ${describeError(err)}\n`);
});

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (err) => {
    process.stderr.write(`fatal: ${describeError(err)}\n${(err as Error)?.stack ?? ""}\n`);
    process.exit(1);
  },
);
