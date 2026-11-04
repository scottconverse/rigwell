// Per-automation visual summary (spec 16.8, approved): `<automation folder>/VISUAL.html`, a static page with the
// schedule, status, recent runs and the latest outputs. It is regenerated after every run, and when the automation is
// created or edited. The page has no network access: no remote scripts, styles, fonts or images, and a CSP that forbids
// them. The only script is an inline listener so a host app can send `{type: "theme", theme: "light" | "dark"}`
// with postMessage. A VISUAL.html that does not carry our marker was written by the user or the agent and is kept.
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { atomicWrite, type Automation, type RunRecord } from "./store.ts";

export const VISUAL_MARKER = "<!-- rigwell-generated-visual v1 -->";
export const VISUAL_FILE = "VISUAL.html";

export interface VisualInput {
  automation: Automation;
  runs: RunRecord[];
  nextRunAt?: number;
  now: number;
  /** Report excerpt reader; defaults to reading from the automation's reports folder. */
  readReport?: (file: string) => string | undefined;
}

const esc = (s: unknown) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const iso = (t?: number) => (t ? new Date(t).toISOString().replace(".000Z", "Z") : "never");
const dur = (r: RunRecord) => {
  if (!r.finishedAt) return "running";
  const s = Math.max(0, Math.round((r.finishedAt - r.startedAt) / 1000));
  return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
};

export function automationStatus(a: Automation): "invalid" | "paused" | "degraded" | "active" {
  return !a.isValid ? "invalid" : a.fm.paused ? "paused" : a.state.health === "degraded" ? "degraded" : "active";
}

function excerpt(text: string | undefined): string {
  if (!text) return "";
  const body = text.replace(/^#.*\n+/, "").trim();
  return body.length > 400 ? `${body.slice(0, 400)}...` : body;
}

export function renderVisual(inp: VisualInput): string {
  const a = inp.automation;
  const status = automationStatus(a);
  const runs = [...inp.runs].sort((x, y) => y.startedAt - x.startedAt);
  const recent = runs.slice(0, 20);
  const done = runs.filter((r) => r.status === "success" || r.status === "failure");
  const okCount = done.filter((r) => r.status === "success").length;
  const rate = done.length ? `${Math.round((okCount / done.length) * 100)}%` : "no runs yet";
  const readReport = inp.readReport ?? ((f: string) => { try { return readFileSync(join(a.dir, "reports", f), "utf8"); } catch { return undefined; } });

  // Bars: oldest on the left, newest on the right, one per run (last 30). Height is the duration, capped.
  const bars = runs.slice(0, 30).reverse().map((r, i) => {
    const ms = r.finishedAt ? r.finishedAt - r.startedAt : 0;
    const h = Math.max(6, Math.min(48, Math.round(Math.log10(ms + 10) * 12)));
    const cls = r.status === "success" ? "ok" : r.status === "failure" ? "bad" : "run";
    return `<rect class="${cls}" x="${i * 10}" y="${52 - h}" width="8" height="${h}"><title>${esc(r.status)} ${esc(iso(r.startedAt))} ${esc(dur(r))}</title></rect>`;
  }).join("");

  const rows = recent.map((r) => `<tr><td><span class="pill ${esc(r.status)}">${esc(r.status)}</span></td><td>${esc(r.trigger)}${r.attempt > 1 ? " (retry)" : ""}</td>` +
    `<td>${esc(iso(r.startedAt))}</td><td>${esc(dur(r))}</td><td>${esc(r.failureReason ?? "")}${r.errorMessage ? ` <span class="muted">${esc(r.errorMessage.slice(0, 160))}</span>` : ""}</td>` +
    `<td>${r.reportFile ? `<code>reports/${esc(r.reportFile)}</code>` : ""}</td></tr>`).join("");

  const outputs = recent.filter((r) => r.reportFile).slice(0, 3).map((r) =>
    `<article><h3><code>reports/${esc(r.reportFile)}</code> <span class="pill ${esc(r.status)}">${esc(r.status)}</span></h3><pre>${esc(excerpt(readReport(r.reportFile!)))}</pre></article>`).join("");

  const extra = [...(a.fm.tags?.length ? [`Tags: ${a.fm.tags.map(esc).join(", ")}`] : []), ...(a.fm.model ? [`Model: ${esc(a.fm.model)}`] : [])].join(" &middot; ");
  const trig = a.fm.trigger ?? "schedule";
  const sched = trig === "webhook" && !a.fm.schedule ? "webhook only" : esc(a.fm.schedule ?? "none");

  return `<!doctype html>
${VISUAL_MARKER}
<html lang="en" data-theme="auto">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data:">
<title>${esc(a.fm.name)}</title>
<style>
:root{--bg:#fbfbfa;--fg:#1d1d1b;--muted:#6a6a64;--card:#fff;--line:#e2e1dc;--ok:#2f7d4f;--bad:#b3392f;--run:#8a6d1c;--warn:#8a6d1c}
@media (prefers-color-scheme:dark){:root[data-theme=auto]{--bg:#151514;--fg:#ecebe6;--muted:#9c9b94;--card:#1e1e1c;--line:#34342f;--ok:#5cc08a;--bad:#ee7a6f;--run:#d9b45a;--warn:#d9b45a}}
:root[data-theme=dark]{--bg:#151514;--fg:#ecebe6;--muted:#9c9b94;--card:#1e1e1c;--line:#34342f;--ok:#5cc08a;--bad:#ee7a6f;--run:#d9b45a;--warn:#d9b45a}
:root[data-theme=light]{--bg:#fbfbfa;--fg:#1d1d1b;--muted:#6a6a64;--card:#fff;--line:#e2e1dc;--ok:#2f7d4f;--bad:#b3392f;--run:#8a6d1c;--warn:#8a6d1c}
*{box-sizing:border-box}body{margin:0;padding:24px 16px;background:var(--bg);color:var(--fg);font:14px/1.5 system-ui,sans-serif}
main{max-width:960px;margin:0 auto}h1{margin:0 0 4px;font-size:22px}h2{font-size:15px;margin:28px 0 8px}h3{font-size:13px;margin:0 0 6px}
.muted{color:var(--muted)}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:10px;margin-top:16px}
.card{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:10px 12px}.card b{display:block;font-size:12px;color:var(--muted);font-weight:500}
.card span{font-size:15px;word-break:break-word}
.pill{display:inline-block;padding:0 8px;border-radius:99px;border:1px solid var(--line);font-size:12px}
.pill.success,.pill.active{color:var(--ok);border-color:var(--ok)}.pill.failure,.pill.invalid{color:var(--bad);border-color:var(--bad)}
.pill.in_progress,.pill.degraded,.pill.paused{color:var(--warn);border-color:var(--warn)}
table{width:100%;border-collapse:collapse;background:var(--card);border:1px solid var(--line);border-radius:8px;display:block;overflow-x:auto}
th,td{text-align:left;padding:6px 10px;border-bottom:1px solid var(--line);white-space:nowrap}td:nth-child(5){white-space:normal}
svg{width:100%;max-width:300px;height:56px}svg .ok{fill:var(--ok)}svg .bad{fill:var(--bad)}svg .run{fill:var(--run)}
pre{margin:0;padding:10px;background:var(--card);border:1px solid var(--line);border-radius:8px;white-space:pre-wrap;word-break:break-word}
article{margin-bottom:12px}code{font-family:ui-monospace,monospace;font-size:12px}
</style>
</head>
<body>
<main>
<h1>${esc(a.fm.name)} <span class="pill ${status}">${status}</span></h1>
<div class="muted">${esc(a.fm.description ?? "")}${extra ? `${a.fm.description ? " &middot; " : ""}${extra}` : ""}</div>
${a.state.pausedReason ? `<p class="muted">Paused automatically: ${esc(a.state.pausedReason)}</p>` : ""}
${!a.isValid ? `<p class="muted">Invalid (${esc(a.invalidReason)}): ${esc(a.error)}</p>` : ""}
<div class="grid">
<div class="card"><b>Schedule</b><span>${sched}</span></div>
<div class="card"><b>Time zone</b><span>${esc(a.timezone)}</span></div>
<div class="card"><b>Trigger</b><span>${esc(trig)}</span></div>
<div class="card"><b>Next run</b><span>${esc(inp.nextRunAt ? iso(inp.nextRunAt) : status === "paused" ? "paused" : "none")}</span></div>
<div class="card"><b>Last run</b><span>${esc(iso(a.state.lastRunAt))}${a.state.lastRunStatus ? ` (${esc(a.state.lastRunStatus)})` : ""}</span></div>
<div class="card"><b>Runs</b><span>${esc(a.state.runCount)} total &middot; success rate ${esc(rate)}</span></div>
</div>
<h2>Recent runs</h2>
${bars ? `<svg viewBox="0 0 300 56" role="img" aria-label="Run history, oldest to newest">${bars}</svg>` : ""}
${rows ? `<table><thead><tr><th>Status</th><th>Trigger</th><th>Started (UTC)</th><th>Duration</th><th>Problem</th><th>Report</th></tr></thead><tbody>${rows}</tbody></table>` : `<p class="muted">No runs yet.</p>`}
<h2>Latest outputs</h2>
${outputs || `<p class="muted">No reports yet.</p>`}
<p class="muted">Generated ${esc(iso(inp.now))}. This page is rebuilt after every run.</p>
</main>
<script>
addEventListener("message",function(e){var d=e.data;if(d&&d.type==="theme"&&(d.theme==="light"||d.theme==="dark"||d.theme==="auto"))document.documentElement.setAttribute("data-theme",d.theme);});
</script>
</body>
</html>
`;
}

/** Writes VISUAL.html unless the user's or agent's own page is there. Returns false when it was kept. Never throws. */
export function writeVisual(inp: VisualInput): boolean {
  const file = join(inp.automation.dir, VISUAL_FILE);
  try {
    if (existsSync(file) && !readFileSync(file, "utf8").includes(VISUAL_MARKER)) return false;
    mkdirSync(inp.automation.dir, { recursive: true });
    atomicWrite(file, renderVisual(inp));
    return true;
  } catch {
    return false;
  }
}
