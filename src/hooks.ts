import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import type { HookShell } from "./config.js";
import { IS_WINDOWS, killTree } from "./process.js";

export interface ShellResult {
  ok: boolean;
  exitCode: number | null;
  timedOut: boolean;
  output: string;
  error?: string;
}

const MAX_CAPTURE = 64 * 1024;

/** Locates Git Bash on Windows (Claude Code also relies on it). */
export function findWindowsBash(env: NodeJS.ProcessEnv = process.env): string {
  const candidates = [
    env.CLAUDE_CODE_GIT_BASH_PATH,
    env.ProgramFiles && path.join(env.ProgramFiles, "Git", "bin", "bash.exe"),
    env["ProgramFiles(x86)"] && path.join(env["ProgramFiles(x86)"], "Git", "bin", "bash.exe"),
    env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, "Programs", "Git", "bin", "bash.exe"),
  ].filter((c): c is string => !!c);
  for (const c of candidates) if (fs.existsSync(c)) return c;
  return "bash";
}

export function shellInvocation(shell: HookShell, script: string): { file: string; args: string[] } {
  switch (shell) {
    case "bash":
      return { file: IS_WINDOWS ? findWindowsBash() : "bash", args: ["-lc", script] };
    case "sh":
      return { file: "sh", args: ["-lc", script] };
    case "powershell":
    case "pwsh": {
      // Encoded command avoids all quoting issues with multi-line scripts. The trailer makes a
      // failing native command (e.g. `git clone`) fail the hook.
      const wrapped =
        "$ErrorActionPreference = 'Stop'\n$PSNativeCommandUseErrorActionPreference = $true\n" +
        script +
        "\nif ($LASTEXITCODE) { exit $LASTEXITCODE }\n";
      const encoded = Buffer.from(wrapped, "utf16le").toString("base64");
      return {
        file: shell === "pwsh" ? "pwsh" : IS_WINDOWS ? "powershell.exe" : "pwsh",
        args: ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encoded],
      };
    }
  }
}

/** Runs a hook script with `cwd` and a hard timeout (SPEC 9.4, 15.4). Never throws. */
export function runShellScript(
  script: string,
  opts: { cwd: string; timeoutMs: number; shell: HookShell; env?: NodeJS.ProcessEnv },
): Promise<ShellResult> {
  return new Promise((resolve) => {
    const { file, args } = shellInvocation(opts.shell, script);
    let output = "";
    let timedOut = false;
    let settled = false;
    const finish = (r: ShellResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(r);
    };

    let child;
    try {
      child = spawn(file, args, {
        cwd: opts.cwd,
        env: opts.env ?? process.env,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
        detached: !IS_WINDOWS,
      });
    } catch (err) {
      resolve({ ok: false, exitCode: null, timedOut: false, output: "", error: (err as Error).message });
      return;
    }
    const collect = (chunk: Buffer) => {
      if (output.length < MAX_CAPTURE) output += chunk.toString("utf8");
    };
    child.stdout?.on("data", collect);
    child.stderr?.on("data", collect);
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child, "SIGKILL");
      finish({ ok: false, exitCode: null, timedOut: true, output, error: `timed out after ${opts.timeoutMs}ms` });
    }, opts.timeoutMs);
    child.on("error", (err) => finish({ ok: false, exitCode: null, timedOut, output, error: err.message }));
    child.on("close", (code) => {
      finish({ ok: code === 0 && !timedOut, exitCode: code, timedOut, output, error: code === 0 ? undefined : `exit code ${code}` });
    });
  });
}
