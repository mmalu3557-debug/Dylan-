import { spawn, spawnSync, type ChildProcess, type SpawnOptions } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const IS_WINDOWS = process.platform === "win32";

export interface ResolvedCommand {
  /** Absolute path (or bare name when resolution is not possible). */
  file: string;
  /** True for `.cmd`/`.bat` shims, which must be started through cmd.exe on Windows. */
  needsCmdShell: boolean;
}

function isExecutableFile(p: string): boolean {
  try {
    const st = fs.statSync(p);
    if (!st.isFile()) return false;
    if (IS_WINDOWS) return true;
    fs.accessSync(p, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Finds an executable on PATH (honouring PATHEXT on Windows). Also checks the default location
 * of the Claude Code native installer (`~/.local/bin`) because a freshly installed CLI is often
 * not yet on the PATH of an already-open terminal.
 */
export function resolveCommand(command: string, env: NodeJS.ProcessEnv = process.env): ResolvedCommand | null {
  const cmd = command.trim();
  if (cmd === "") return null;
  const exts = IS_WINDOWS
    ? (env.PATHEXT ?? env.Pathext ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean).map((e) => e.toLowerCase())
    : [""];
  const candidatesFor = (base: string): string[] => {
    if (!IS_WINDOWS) return [base];
    const ext = path.extname(base).toLowerCase();
    if (ext && exts.includes(ext)) return [base];
    return exts.map((e) => base + e);
  };
  const wrap = (file: string): ResolvedCommand => ({
    file,
    needsCmdShell: IS_WINDOWS && /\.(cmd|bat)$/i.test(file),
  });

  const hasDir = cmd.includes("/") || cmd.includes("\\");
  if (hasDir || path.isAbsolute(cmd)) {
    for (const c of candidatesFor(path.resolve(cmd))) if (isExecutableFile(c)) return wrap(c);
    return null;
  }

  const pathVar = env.PATH ?? env.Path ?? env.path ?? "";
  const dirs = pathVar.split(path.delimiter).filter(Boolean);
  dirs.push(path.join(os.homedir(), ".local", "bin"));
  for (const dir of dirs) {
    for (const c of candidatesFor(path.join(dir.replace(/^"|"$/g, ""), cmd))) {
      if (isExecutableFile(c)) return wrap(c);
    }
  }
  return null;
}

/** Quotes one argument for a cmd.exe command line. */
function quoteForCmd(arg: string): string {
  if (arg === "") return '""';
  if (!/[\s"&|<>^()%!,;]/.test(arg)) return arg;
  return '"' + arg.replace(/"/g, '""') + '"';
}

/** Spawns a resolved command with an argument array (no shell interpolation of args). */
export function spawnResolved(cmd: ResolvedCommand, args: string[], opts: SpawnOptions): ChildProcess {
  if (cmd.needsCmdShell) {
    const line = [cmd.file, ...args].map(quoteForCmd).join(" ");
    return spawn(env("ComSpec", opts.env) ?? "cmd.exe", ["/d", "/s", "/c", `"${line}"`], {
      ...opts,
      windowsVerbatimArguments: true,
    });
  }
  return spawn(cmd.file, args, { ...opts, detached: !IS_WINDOWS });
}

function env(name: string, e?: NodeJS.ProcessEnv): string | undefined {
  return (e ?? process.env)[name];
}

/** Kills a child and all of its descendants. */
export function killTree(child: ChildProcess, signal: NodeJS.Signals = "SIGTERM"): void {
  const pid = child.pid;
  if (pid === undefined || child.exitCode !== null || child.signalCode !== null) return;
  if (IS_WINDOWS) {
    try {
      spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
    } catch {
      child.kill();
    }
    return;
  }
  try {
    process.kill(-pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      /* already gone */
    }
  }
  if (signal !== "SIGKILL") {
    const t = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) killTree(child, "SIGKILL");
    }, 5000);
    t.unref();
  }
}

/** Copy of `base` without the given variable names (case-insensitive on Windows). */
export function scrubEnv(base: NodeJS.ProcessEnv, remove: string[]): NodeJS.ProcessEnv {
  const drop = new Set(remove.map((n) => (IS_WINDOWS ? n.toUpperCase() : n)));
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(base)) {
    if (drop.has(IS_WINDOWS ? k.toUpperCase() : k)) continue;
    out[k] = v;
  }
  return out;
}
