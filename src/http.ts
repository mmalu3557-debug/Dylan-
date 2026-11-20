import http from "node:http";
import type { AddressInfo } from "node:net";
import type { Logger } from "./log.js";
import type { Orchestrator } from "./orchestrator.js";

/** OPTIONAL HTTP extension (SPEC 13.7): dashboard at `/`, JSON API under `/api/v1/*`. */
export class StatusServer {
  private server: http.Server | null = null;

  constructor(
    private readonly orchestrator: Orchestrator,
    private readonly logger: Logger,
  ) {}

  async start(port: number, host: string): Promise<number> {
    const server = http.createServer((req, res) => {
      try {
        this.route(req, res);
      } catch (err) {
        this.logger.error("dashboard request failed", { reason: (err as Error).message });
        sendJson(res, 500, { error: { code: "internal_error", message: "internal error" } });
      }
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, host, () => resolve());
    });
    this.server = server;
    const actual = (server.address() as AddressInfo).port;
    this.logger.info("dashboard listening", { url: `http://${host === "0.0.0.0" ? "localhost" : host}:${actual}/` });
    return actual;
  }

  async stop(): Promise<void> {
    const s = this.server;
    this.server = null;
    if (!s) return;
    s.closeAllConnections?.();
    await new Promise<void>((resolve) => s.close(() => resolve()));
  }

  private route(req: http.IncomingMessage, res: http.ServerResponse): void {
    const url = new URL(req.url ?? "/", "http://localhost");
    const p = url.pathname;
    const method = req.method ?? "GET";

    if (p === "/") {
      if (method !== "GET") return methodNotAllowed(res, "GET");
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(DASHBOARD_HTML);
      return;
    }
    if (p === "/api/v1/state") {
      if (method !== "GET") return methodNotAllowed(res, "GET");
      return sendJson(res, 200, this.orchestrator.snapshot());
    }
    if (p === "/api/v1/refresh") {
      if (method !== "POST") return methodNotAllowed(res, "POST");
      const coalesced = this.orchestrator.requestRefresh();
      return sendJson(res, 202, {
        queued: true,
        coalesced,
        requested_at: new Date().toISOString(),
        operations: ["poll", "reconcile"],
      });
    }
    const m = /^\/api\/v1\/([^/]+)$/.exec(p);
    if (m) {
      if (method !== "GET") return methodNotAllowed(res, "GET");
      const id = decodeURIComponent(m[1]);
      const details = this.orchestrator.issueDetails(id);
      if (!details) return sendJson(res, 404, { error: { code: "issue_not_found", message: `issue ${id} is not known to this Symphony process` } });
      return sendJson(res, 200, details);
    }
    sendJson(res, 404, { error: { code: "not_found", message: "route not found" } });
  }
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(body, null, 2));
}

function methodNotAllowed(res: http.ServerResponse, allow: string): void {
  res.setHeader("Allow", allow);
  sendJson(res, 405, { error: { code: "method_not_allowed", message: `use ${allow}` } });
}

const DASHBOARD_HTML = `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Symphony</title>
<style>
  :root { --bg:#f7f7f8; --fg:#1b1b1f; --muted:#6b6b76; --card:#fff; --line:#e3e3e8; --ok:#1a7f37; --warn:#9a6700; --err:#cf222e; --accent:#3b5bdb; }
  @media (prefers-color-scheme: dark) { :root { --bg:#141417; --fg:#ececf1; --muted:#9a9aa5; --card:#1d1d22; --line:#2c2c33; --ok:#3fb950; --warn:#d29922; --err:#f85149; --accent:#7c94ff; } }
  * { box-sizing: border-box; }
  body { margin:0; font:14px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif; background:var(--bg); color:var(--fg); }
  main { max-width:1100px; margin:0 auto; padding:24px 16px; }
  h1 { font-size:20px; margin:0 0 4px; }
  h2 { font-size:15px; margin:28px 0 8px; }
  .muted { color:var(--muted); }
  .tiles { display:grid; grid-template-columns:repeat(auto-fit,minmax(150px,1fr)); gap:12px; margin-top:16px; }
  .tile { background:var(--card); border:1px solid var(--line); border-radius:10px; padding:12px 14px; }
  .tile b { display:block; font-size:22px; font-variant-numeric:tabular-nums; }
  table { width:100%; border-collapse:collapse; background:var(--card); border:1px solid var(--line); border-radius:10px; overflow:hidden; }
  th, td { text-align:left; padding:8px 10px; border-bottom:1px solid var(--line); vertical-align:top; }
  th { font-weight:600; color:var(--muted); font-size:12px; }
  tr:last-child td { border-bottom:none; }
  td.msg { max-width:420px; overflow-wrap:anywhere; color:var(--muted); }
  .wrap { overflow-x:auto; }
  .alert { background:var(--card); border:1px solid var(--err); color:var(--err); padding:10px 12px; border-radius:10px; margin-top:12px; overflow-wrap:anywhere; }
  a { color:var(--accent); }
  button { font:inherit; padding:6px 12px; border-radius:8px; border:1px solid var(--line); background:var(--card); color:var(--fg); cursor:pointer; }
</style>
</head>
<body>
<main>
  <h1>Symphony</h1>
  <div class="muted" id="sub">carregando…</div>
  <div id="alerts"></div>
  <div class="tiles" id="tiles"></div>
  <h2>Rodando agora</h2>
  <div class="wrap"><table><thead><tr><th>Issue</th><th>Estado</th><th>Turnos</th><th>Último evento</th><th>Tokens</th><th>Desde</th></tr></thead><tbody id="running"></tbody></table></div>
  <h2>Fila de nova tentativa</h2>
  <div class="wrap"><table><thead><tr><th>Issue</th><th>Tentativa</th><th>Quando</th><th>Motivo</th></tr></thead><tbody id="retrying"></tbody></table></div>
  <p><button id="refresh">Verificar o Linear agora</button></p>
</main>
<script>
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const fmt = (n) => Number(n || 0).toLocaleString("pt-BR");
const ago = (iso) => { if (!iso) return "—"; const s = Math.round((Date.now() - new Date(iso)) / 1000); return s < 60 ? s + "s" : s < 3600 ? Math.round(s/60) + "min" : Math.round(s/3600) + "h"; };
const until = (iso) => { const s = Math.round((new Date(iso) - Date.now()) / 1000); return s <= 0 ? "agora" : "em " + s + "s"; };
const link = (id, url) => url ? '<a href="' + esc(url) + '" target="_blank" rel="noopener">' + esc(id) + '</a>' : esc(id);
async function load() {
  try {
    const st = await (await fetch("/api/v1/state")).json();
    const t = st.codex_totals, h = st.health || {};
    document.getElementById("sub").textContent = "Atualizado " + new Date(st.generated_at).toLocaleTimeString("pt-BR") + " · última verificação do Linear há " + ago(h.last_tick_at);
    const alerts = [h.workflow_error, h.dispatch_error, h.tracker_error].filter(Boolean);
    document.getElementById("alerts").innerHTML = alerts.map((a) => '<div class="alert">' + esc(a) + '</div>').join("");
    document.getElementById("tiles").innerHTML = [
      ["Rodando", st.counts.running + " / " + (h.max_concurrent_agents ?? "?")],
      ["Na fila", st.counts.retrying],
      ["Tokens", fmt(t.total_tokens)],
      ["Custo (US$)", (t.cost_usd || 0).toFixed(2)],
      ["Tempo de agente", Math.round(t.seconds_running / 60) + " min"],
    ].map(([k, v]) => '<div class="tile"><span class="muted">' + k + '</span><b>' + esc(v) + '</b></div>').join("");
    document.getElementById("running").innerHTML = st.running.length ? st.running.map((r) =>
      '<tr><td>' + link(r.issue_identifier, r.issue_url) + '<div class="muted">' + esc(r.issue_title) + '</div></td><td>' + esc(r.state) + (r.stopping ? ' (parando)' : '') + '</td><td>' + r.turn_count +
      '</td><td class="msg"><b>' + esc(r.last_event || "—") + '</b> ' + esc(r.last_message) + '</td><td>' + fmt(r.tokens.total_tokens) + '</td><td>' + ago(r.started_at) + '</td></tr>'
    ).join("") : '<tr><td colspan="6" class="muted">Nenhum agente rodando.</td></tr>';
    document.getElementById("retrying").innerHTML = st.retrying.length ? st.retrying.map((r) =>
      '<tr><td>' + link(r.issue_identifier, r.issue_url) + '</td><td>' + r.attempt + '</td><td>' + until(r.due_at) + '</td><td class="msg">' + esc(r.error || "continuação") + '</td></tr>'
    ).join("") : '<tr><td colspan="4" class="muted">Fila vazia.</td></tr>';
  } catch (e) {
    document.getElementById("sub").textContent = "Sem conexão com o Symphony.";
  }
}
document.getElementById("refresh").onclick = async () => { await fetch("/api/v1/refresh", { method: "POST" }); setTimeout(load, 1500); };
load(); setInterval(load, 3000);
</script>
</body>
</html>`;
