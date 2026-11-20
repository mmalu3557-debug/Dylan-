import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { buildServiceConfig, normalizeState } from "./config.js";
import { describeError } from "./errors.js";
import { findWindowsBash } from "./hooks.js";
import { IS_WINDOWS, resolveCommand } from "./process.js";
import { checkTemplateSyntax } from "./template.js";
import { defaultTrackerRegistry, effectiveStates } from "./tracker/index.js";
import { LinearAdapter, resolveLinearSettings } from "./tracker/linear.js";
import { loadWorkflow } from "./workflow.js";

const OK = "✔";
const BAD = "✖";
const WARN = "!";

let failures = 0;
function ok(msg: string) {
  console.log(`  ${OK} ${msg}`);
}
function bad(msg: string, hint?: string) {
  failures++;
  console.log(`  ${BAD} ${msg}`);
  if (hint) console.log(`      → ${hint}`);
}
function warn(msg: string, hint?: string) {
  console.log(`  ${WARN} ${msg}`);
  if (hint) console.log(`      → ${hint}`);
}

function version(file: string, args: string[]): string | null {
  const r = spawnSync(file, args, { encoding: "utf8", shell: IS_WINDOWS && /\.(cmd|bat)$/i.test(file), windowsHide: true, timeout: 20000 });
  if (r.status !== 0) return null;
  return (r.stdout || r.stderr).trim().split(/\r?\n/)[0] ?? "";
}

/** `symphony doctor`: a beginner-friendly checklist of everything Symphony needs. */
export async function runDoctor(workflowPath: string): Promise<number> {
  console.log("\nSymphony doctor\n");

  console.log("1. Node.js");
  const major = Number(process.versions.node.split(".")[0]);
  if (major >= 20) ok(`Node ${process.versions.node}`);
  else bad(`Node ${process.versions.node} é antigo demais`, "instale o Node.js 22 LTS: winget install OpenJS.NodeJS.LTS");

  console.log("\n2. WORKFLOW.md");
  let config;
  try {
    const def = loadWorkflow(workflowPath);
    const built = buildServiceConfig(def, workflowPath);
    config = built.config;
    if (built.errors.length) built.errors.forEach((e) => bad(e));
    else ok(`lido: ${workflowPath}`);
    const tErr = checkTemplateSyntax(def.prompt_template);
    if (tErr) bad(`prompt com erro de sintaxe: ${tErr}`);
  } catch (err) {
    bad(describeError(err));
    console.log(`\n${failures} problema(s) encontrado(s).\n`);
    return 1;
  }

  console.log("\n3. Claude Code");
  const claude = resolveCommand(config.claude.command);
  if (!claude) {
    bad(
      `"${config.claude.command}" não encontrado`,
      IS_WINDOWS
        ? "instale no PowerShell: irm https://claude.ai/install.ps1 | iex   (depois feche e abra o terminal)"
        : "instale: curl -fsSL https://claude.ai/install.sh | bash",
    );
  } else {
    const v = version(claude.file, ["--version"]);
    if (v) ok(`${claude.file} (${v})`);
    else bad(`${claude.file} não respondeu a --version`);
  }
  if (process.env.CLAUDE_CODE_OAUTH_TOKEN) ok("CLAUDE_CODE_OAUTH_TOKEN definido");
  else if (process.env.ANTHROPIC_API_KEY) warn("usando ANTHROPIC_API_KEY (cobrança por uso da API)");
  else
    warn(
      "CLAUDE_CODE_OAUTH_TOKEN não definido",
      'rode "claude setup-token" e salve o token: setx CLAUDE_CODE_OAUTH_TOKEN "<token>" (ou faça login com "claude")',
    );
  if (process.env.CLAUDE_CODE_OAUTH_TOKEN && process.env.ANTHROPIC_API_KEY) {
    warn("ANTHROPIC_API_KEY também está definido e tem prioridade sobre o token OAuth", "remova-o se quiser usar sua assinatura");
  }

  console.log("\n4. Linear");
  const states = effectiveStates(config, defaultTrackerRegistry().get("linear"));
  if (config.tracker.kind !== "linear") {
    bad(`tracker.kind deve ser "linear" (atual: ${config.tracker.kind})`);
  } else {
    const { settings, errors } = resolveLinearSettings(config.tracker, process.env);
    errors.forEach((e) =>
      bad(e, /API key/i.test(e) ? 'crie em Linear → Settings → Security & access → Personal API keys, depois: setx LINEAR_API_KEY "<chave>"' : undefined),
    );
    if (settings) {
      ok(`chave do Linear encontrada (${settings.apiKeyEnvName ?? "valor literal"}), projeto ${settings.projectSlug}`);
      const adapter = new LinearAdapter(settings, states);
      try {
        const viewer = await adapter.graphql("query { viewer { name email } }");
        if (viewer.errors) throw new Error(viewer.errors.map((e: any) => e.message).join("; "));
        ok(`autenticado como ${viewer.data?.viewer?.name ?? "?"}`);
        const proj = await adapter.graphql(
          `query($slug: String!) { projects(filter: { slugId: { eq: $slug } }) { nodes { name url teams { nodes { key name states { nodes { name type } } } } } } }`,
          { slug: settings.projectSlug },
        );
        const node = proj.data?.projects?.nodes?.[0];
        if (!node) {
          bad(`projeto "${settings.projectSlug}" não encontrado`, "confira a URL do projeto em WORKFLOW.md (tracker.provider.project_url)");
        } else {
          ok(`projeto: ${node.name}`);
          const names = new Set<string>();
          for (const team of node.teams?.nodes ?? []) {
            const list = (team.states?.nodes ?? []).map((s: any) => `${s.name} (${s.type})`);
            console.log(`      time ${team.key}: ${list.join(", ")}`);
            for (const s of team.states?.nodes ?? []) names.add(normalizeState(s.name));
          }
          for (const s of [...states.active_states]) {
            if (!names.has(normalizeState(s))) bad(`estado ativo "${s}" não existe no time`, "ajuste tracker.active_states em WORKFLOW.md");
          }
          const review = ["in review", "human review", "em revisão", "review"].find((r) => names.has(r));
          if (review) ok(`estado de revisão encontrado: "${review}"`);
          else warn('nenhum estado de revisão (ex.: "In Review") encontrado', "crie um no Linear: Settings → Teams → Workflow");
          const issues = await adapter.fetchIssuesByStates(states.active_states);
          ok(`${issues.length} issue(s) em estados ativos (${states.active_states.join(", ")})`);
        }
      } catch (err) {
        bad(`falha ao falar com o Linear: ${describeError(err)}`);
      }
    }
  }

  console.log("\n5. Git e GitHub");
  const git = resolveCommand("git");
  if (git) ok(`git: ${version(git.file, ["--version"]) ?? git.file}`);
  else bad("git não encontrado", "winget install Git.Git");
  const gh = resolveCommand("gh");
  if (!gh) warn("GitHub CLI (gh) não encontrado — o agente não conseguirá abrir Pull Requests", "winget install GitHub.cli e depois: gh auth login");
  else {
    const st = spawnSync(gh.file, ["auth", "status"], { encoding: "utf8", windowsHide: true, timeout: 20000 });
    if (st.status === 0) ok("gh autenticado");
    else warn("gh não está autenticado", "rode: gh auth login");
  }

  console.log("\n6. Workspaces e hooks");
  try {
    fs.mkdirSync(config.workspace.root, { recursive: true });
    fs.accessSync(config.workspace.root, fs.constants.W_OK);
    ok(`pasta de workspaces: ${config.workspace.root}`);
  } catch (err) {
    bad(`não consigo escrever em ${config.workspace.root}: ${(err as Error).message}`);
  }
  const shell = config.hooks.shell;
  const shellFile = shell === "bash" ? (IS_WINDOWS ? findWindowsBash() : "bash") : shell === "sh" ? "sh" : shell === "pwsh" ? "pwsh" : IS_WINDOWS ? "powershell.exe" : "pwsh";
  if (resolveCommand(shellFile) || fs.existsSync(shellFile)) ok(`shell dos hooks: ${shell}`);
  else bad(`shell dos hooks "${shell}" não encontrado`);
  if (config.hooks.after_create && /SEU_USUARIO|COLE|<.*>/.test(config.hooks.after_create)) {
    bad("hooks.after_create ainda tem o placeholder do repositório", "coloque a URL do repositório da área logada em WORKFLOW.md");
  }

  console.log(failures ? `\n${failures} problema(s) encontrado(s). Corrija e rode de novo.\n` : "\nTudo certo! Pode iniciar o Symphony.\n");
  return failures ? 1 : 0;
}
