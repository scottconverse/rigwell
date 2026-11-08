// `rigwell doctor`: a checklist of the things that most often keep Rigwell from working (tools, duplicate installs,
// startup, the daemon socket, settings and MCP config). No daemon needed; nothing is started except short version
// probes. Secrets are never printed.
import { existsSync, statSync } from "node:fs";
import path from "node:path";
import pkg from "../../package.json";
import { rigwellHome } from "../storage/paths.ts";
import { daemonSocketPath } from "../daemon/socket-path.ts";

export type DoctorStatus = "pass" | "warn" | "fail";
export interface DoctorCheck { id: string; title: string; status: DoctorStatus; detail: string; fix?: string; items?: string[] }
export interface DoctorReport { version: string; platform: string; checks: DoctorCheck[]; ok: boolean }

type Env = Record<string, string | undefined>;

export interface DoctorOptions {
  env?: Env;
  platform?: NodeJS.Platform;
  cwd?: string;
  /** Rigwell data folder (default rigwellHome()). */
  home?: string;
  /** Command that starts this Rigwell (default: current executable plus script). */
  selfCmd?: string[];
  /** Running version (default: package.json). */
  version?: string;
  /** Milliseconds allowed for each version probe (default 5000) and for the daemon connect (default 1000). */
  probeTimeoutMs?: number;
  connectTimeoutMs?: number;
  /** Startup time above this is a warning (default 2000). */
  slowStartMs?: number;
}

function pathDirs(env: Env, platform: NodeJS.Platform): string[] {
  const key = platform === "win32" ? Object.keys(env).find((k) => k.toLowerCase() === "path" && env[k]) ?? "PATH" : "PATH";
  const raw = env[key] ?? "";
  const sep = platform === "win32" ? ";" : ":";
  return raw.split(sep).map((d) => d.trim().replace(/^"|"$/g, "")).filter(Boolean);
}

/** Every file called one of `names` in a PATH folder, in PATH order (repeats removed). */
export function findOnPath(names: string[], env: Env, platform: NodeJS.Platform = process.platform): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const dir of pathDirs(env, platform)) {
    for (const n of names) {
      const p = path.join(dir, n);
      try {
        if (!statSync(p).isFile()) continue;
      } catch { continue; }
      const key = platform === "win32" ? p.toLowerCase() : p;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(p);
    }
  }
  return out;
}

interface Probe { ok: boolean; out: string; ms: number; error?: string }

async function probe(cmd: string[], env: Env, timeoutMs: number): Promise<Probe> {
  const t0 = performance.now();
  try {
    const proc = Bun.spawn(cmd, { env: env as Record<string, string>, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; proc.kill(); }, timeoutMs);
    const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    clearTimeout(timer);
    const ms = Math.round(performance.now() - t0);
    if (timedOut) return { ok: false, out: "", ms, error: `timed out after ${timeoutMs} ms` };
    if (code !== 0) return { ok: false, out: out.trim(), ms, error: `exit code ${code}${err.trim() ? `: ${err.trim().split(/\r?\n/)[0]}` : ""}` };
    return { ok: true, out: out.trim(), ms };
  } catch (e) {
    return { ok: false, out: "", ms: Math.round(performance.now() - t0), error: (e as Error).message };
  }
}

const firstLine = (s: string) => s.split(/\r?\n/)[0]?.trim() ?? "";
const semver = (s: string) => /\d+\.\d+\.\d+(?:[-+.\w]*)?/.exec(s)?.[0];

function installHint(tool: "git" | "rg", platform: NodeJS.Platform): string {
  if (platform === "win32") return tool === "git" ? "winget install Git.Git" : "winget install BurntSushi.ripgrep.MSVC";
  if (platform === "darwin") return tool === "git" ? "brew install git" : "brew install ripgrep";
  return tool === "git" ? "sudo apt install git (or the dnf/pacman equivalent)" : "sudo apt install ripgrep (or the dnf/pacman equivalent)";
}

async function checkTools(env: Env, platform: NodeJS.Platform, timeout: number): Promise<DoctorCheck[]> {
  const exts = platform === "win32" ? [".exe", ".cmd", ".bat"] : [""];
  const res: DoctorCheck[] = [];
  for (const tool of ["git", "rg"] as const) {
    const title = tool === "git" ? "git" : "rg (ripgrep)";
    const found = findOnPath(exts.map((e) => tool + e), env, platform)[0];
    const fix = `Install it with: ${installHint(tool, platform)}. The installed desktop app does not bundle it.`;
    if (!found) { res.push({ id: tool, title, status: "fail", detail: "not found on PATH", fix }); continue; }
    const r = await probe([found, "--version"], env, timeout);
    if (!r.ok) res.push({ id: tool, title, status: "fail", detail: `${found} failed: ${r.error}`, fix });
    else res.push({ id: tool, title, status: "pass", detail: `${firstLine(r.out)} (${found})` });
  }
  return res;
}

async function checkCopies(env: Env, platform: NodeJS.Platform, timeout: number, running: string): Promise<DoctorCheck> {
  const names = platform === "win32" ? ["rigwell.exe", "rigwell.cmd", "rigwell.ps1", "rigwell.bat", "rigwell"] : ["rigwell"];
  const copies = findOnPath(names, env, platform);
  const title = "rigwell on PATH";
  if (!copies.length) return { id: "copies", title, status: "warn", detail: "no rigwell found on PATH (the desktop app or a script launch is fine)", fix: "Add the folder that holds rigwell to PATH if you want to run it from any terminal." };
  const items: string[] = [];
  const versions = new Set<string>();
  for (const c of copies) {
    const cmd = c.toLowerCase().endsWith(".ps1") ? ["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", c, "--version"] : [c, "--version"];
    const r = await probe(cmd, env, timeout);
    const v = r.ok ? semver(r.out) ?? firstLine(r.out) : undefined;
    if (v) versions.add(v);
    items.push(`${c}: ${r.ok ? v : `could not read the version (${r.error})`}`);
  }
  const differs = [...versions].some((v) => v !== running);
  if (copies.length > 1 || differs) {
    const why = [copies.length > 1 ? `${copies.length} copies found` : "", differs ? `version differs from the running ${running}` : ""].filter(Boolean).join("; ");
    return { id: "copies", title, status: "warn", detail: why, fix: "Remove the older copies so the one that runs first on PATH is the one you expect.", items };
  }
  return { id: "copies", title, status: "pass", detail: `1 copy, version ${[...versions][0] ?? "unknown"}`, items };
}

async function checkStartup(selfCmd: string[], env: Env, slowMs: number): Promise<DoctorCheck> {
  const title = "rigwell starts";
  const r = await probe([...selfCmd, "--version"], env, Math.max(slowMs * 5, 10000));
  if (!r.ok) return { id: "startup", title, status: "fail", detail: `${selfCmd.join(" ")} --version failed: ${r.error}`, fix: "Reinstall Rigwell, or run it with --version to see the error." };
  if (r.ms > slowMs) return { id: "startup", title, status: "warn", detail: `started in ${r.ms} ms (slower than ${slowMs} ms)`, fix: "Check antivirus exclusions for the Rigwell folder and for bun." };
  return { id: "startup", title, status: "pass", detail: `started in ${r.ms} ms (${firstLine(r.out)})` };
}

function tryConnect(socketPath: string, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    let done = false;
    let sock: { end(): void } | undefined;
    const timer = setTimeout(() => finish(false), timeoutMs);
    const finish = (ok: boolean) => { if (done) return; done = true; clearTimeout(timer); try { sock?.end(); } catch {} resolve(ok); };
    Bun.connect({ unix: socketPath, socket: { open(s) { sock = s; finish(true); }, data() {}, error() { finish(false); }, close() { finish(false); }, connectError() { finish(false); } } })
      .then((s) => { sock = s; }, () => finish(false));
  });
}

async function checkDaemon(home: string, timeoutMs: number): Promise<DoctorCheck> {
  const title = "daemon";
  const socketPath = daemonSocketPath(home);
  const present = existsSync(socketPath);
  if (present && (await tryConnect(socketPath, timeoutMs))) return { id: "daemon", title, status: "pass", detail: `running (${socketPath})` };
  if (present) return { id: "daemon", title, status: "warn", detail: `stale socket file, nothing is listening: ${socketPath}`, fix: `Delete ${socketPath}, or start the daemon again with: rigwell daemon` };
  const info = path.join(home, "daemon.json");
  if (existsSync(info)) return { id: "daemon", title, status: "warn", detail: `not running, but ${info} is left over`, fix: `Delete ${info}; it is rewritten when the daemon starts.` };
  return { id: "daemon", title, status: "pass", detail: "not running (optional; start it with: rigwell daemon)" };
}

/** Hides anything that looks like a key or token. */
const scrub = (s: string) => s.replace(/\b(?:sk|pk|key|tok|ghp|xox[a-z])[-_][A-Za-z0-9_-]{8,}/gi, "[hidden]").replace(/\bBearer\s+\S+/gi, "Bearer [hidden]");

async function checkConfig(cwd: string, env: Env, home: string): Promise<DoctorCheck[]> {
  const checks: DoctorCheck[] = [];
  const { loadSettings } = await import("../storage/settings.ts");
  const { validateCustomModels } = await import("../storage/models.ts");
  const loaded = loadSettings({ cwd, env });
  const modelProblems = validateCustomModels(loaded.settings, env).problems;
  const customs = (Array.isArray(loaded.settings.customModels) ? loaded.settings.customModels : []).map((m) => String(m?.model ?? "?"));
  const configured = loaded.settings.sessionDefaultSettings?.model;
  const problems = [...loaded.warnings, ...modelProblems.map((p) => `customModels[${p.index}]${p.model ? ` (${p.model})` : ""}: ${p.message}`)];
  checks.push({
    id: "settings", title: "settings and models", status: problems.length ? "warn" : "pass",
    detail: `${loaded.sources.filter((s) => s.path).length} settings file(s); model: ${configured ?? "(default)"}; custom models: ${customs.length ? customs.join(", ") : "none"}${problems.length ? `; ${problems.length} problem(s)` : ""}`,
    fix: problems.length ? "Fix the settings listed, then run doctor again." : undefined,
    items: problems.map(scrub),
  });
  const other: string[] = [];
  try { other.push(...(await import("../hooks/index.ts")).loadHooksConfig({ cwd }).warnings); } catch (e) { other.push(`hooks could not be loaded: ${(e as Error).message}`); }
  try {
    const { SkillRegistry } = await import("../skills/index.ts");
    for (const k of new SkillRegistry({ cwd }).load().all) if (k.status === "invalid") other.push(`skill ${k.filePath}: ${k.errors.join("; ")}`);
  } catch (e) { other.push(`skills could not be loaded: ${(e as Error).message}`); }
  checks.push({ id: "hooks-skills", title: "hooks and skills", status: other.length ? "warn" : "pass", detail: other.length ? `${other.length} problem(s)` : "no problems", items: other.map(scrub) });
  try {
    const { loadMcpConfig } = await import("../mcp/config.ts");
    const mcp = loadMcpConfig({ cwd, homeDir: home });
    checks.push({
      id: "mcp", title: "MCP settings", status: mcp.warnings.length ? "warn" : "pass",
      detail: `${mcp.servers.length} server(s) configured${mcp.servers.length ? ` (${mcp.servers.map((s) => s.name).join(", ")})` : ""}${mcp.warnings.length ? `; ${mcp.warnings.length} problem(s)` : ""}; servers are not started`,
      fix: mcp.warnings.length ? "Fix or remove the entries listed (mcp.json at user, project or folder level)." : undefined,
      items: mcp.warnings.map(scrub),
    });
  } catch (e) {
    checks.push({ id: "mcp", title: "MCP settings", status: "fail", detail: `could not load the MCP config: ${scrub((e as Error).message)}` });
  }
  return checks;
}

function defaultSelfCmd(): string[] {
  const script = process.argv[1];
  return script && existsSync(script) && path.resolve(script) !== path.resolve(process.execPath) ? [process.execPath, script] : [process.execPath];
}

export async function runDoctor(opts: DoctorOptions = {}): Promise<DoctorReport> {
  const env = opts.env ?? (process.env as Env);
  const platform = opts.platform ?? process.platform;
  const version = opts.version ?? pkg.version;
  const timeout = opts.probeTimeoutMs ?? 5000;
  const home = opts.home ?? rigwellHome();
  const checks: DoctorCheck[] = [];
  checks.push(...(await checkTools(env, platform, timeout)));
  checks.push(await checkCopies(env, platform, timeout, version));
  checks.push(await checkStartup(opts.selfCmd ?? defaultSelfCmd(), env, opts.slowStartMs ?? 2000));
  checks.push(await checkDaemon(home, opts.connectTimeoutMs ?? 1000));
  checks.push(...(await checkConfig(opts.cwd ?? process.cwd(), env, home)));
  return { version, platform, checks, ok: !checks.some((c) => c.status === "fail") };
}

const MARK: Record<DoctorStatus, string> = { pass: "[ ok ]", warn: "[warn]", fail: "[FAIL]" };

export function formatReport(r: DoctorReport): string {
  const lines = [`Rigwell ${r.version} doctor (${r.platform})`, ""];
  for (const c of r.checks) {
    lines.push(`${MARK[c.status]} ${c.title}: ${c.detail}`);
    for (const i of c.items ?? []) lines.push(`         - ${i}`);
    if (c.fix && c.status !== "pass") lines.push(`         fix: ${c.fix}`);
  }
  const n = (s: DoctorStatus) => r.checks.filter((c) => c.status === s).length;
  lines.push("", `${n("pass")} ok, ${n("warn")} warning(s), ${n("fail")} failure(s).`);
  return lines.join("\n") + "\n";
}

/** CLI entry: prints the report and returns the exit code (0 when nothing failed, 1 otherwise). */
export async function doctorMain(argv: string[], opts: DoctorOptions = {}, out: (s: string) => void = (s) => void process.stdout.write(s)): Promise<number> {
  const report = await runDoctor(opts);
  out(argv.includes("--json") ? JSON.stringify(report, null, 2) + "\n" : formatReport(report));
  return report.ok ? 0 : 1;
}
