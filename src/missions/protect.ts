// File protection (spec §15.3): file tools check paths before acting, resolve symlinks, and test both the
// given path and the real path. state.json, progress_log.jsonl and model-settings.json are closed to every
// agent; features.json is closed to writes from workers (they report through EndFeatureRun).
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { Tool, ToolContext, ToolOutput } from "../core/types.ts";
import { checkFeaturesJson, checkValidationState, missionsRoot, PROTECTED_MISSION_FILES } from "./store.ts";

export type AgentRole = "orchestrator" | "worker" | "other";

const UNRESOLVABLE = Symbol("unresolvable");

function realOf(abs: string): string | typeof UNRESOLVABLE {
  try { return realpathSync(abs); } catch { /* fall through */ }
  try { lstatSync(abs); return UNRESOLVABLE; } catch { /* does not exist */ }
  const parent = dirname(abs);
  if (parent === abs) return abs;
  const r = realOf(parent);
  return r === UNRESOLVABLE ? r : join(r, basename(abs));
}

/** Names of mission files directly inside a mission folder under `root`, for one candidate path. */
function missionFileOf(cand: string, roots: string[]): string | null {
  for (const root of roots) {
    const rel = relative(root, cand);
    if (!rel || rel.startsWith("..") || isAbsolute(rel)) continue;
    const parts = rel.split(sep);
    if (parts.length === 2) return parts[1];
  }
  return null;
}

/** Reason a path may not be used, or null when it may. */
export function checkMissionPath(p: string, cwd: string, role: AgentRole, op: "read" | "write"): string | null {
  const given = resolve(cwd, p);
  const real = realOf(given);
  if (real === UNRESOLVABLE) return `Refused: ${p} is a symlink that cannot be resolved.`;
  const root = missionsRoot();
  const roots = [resolve(root)];
  try { roots.push(realpathSync(root)); } catch { /* no missions yet */ }
  for (const cand of new Set([given, real])) {
    const f = missionFileOf(cand, roots);
    if (!f) continue;
    if (PROTECTED_MISSION_FILES.includes(f)) return `Refused: ${f} belongs to the mission system; no agent may read or write it with tools.`;
    if (f === "features.json" && op === "write" && role === "worker") {
      return "Refused: features.json belongs to the orchestrator. Workers report only through EndFeatureRun.";
    }
  }
  return null;
}

const isMissionJson = (p: string, cwd: string): "features.json" | "validation-state.json" | null => {
  const given = resolve(cwd, p);
  const real = realOf(given);
  const roots = [resolve(missionsRoot())];
  try { roots.push(realpathSync(missionsRoot())); } catch { /* none */ }
  for (const cand of new Set([given, typeof real === "string" ? real : given])) {
    const f = missionFileOf(cand, roots);
    if (f === "features.json" || f === "validation-state.json") return f;
  }
  return null;
};

const refuse = (content: string): ToolOutput => ({ content, isError: true });

export interface ProtectOptions {
  role: AgentRole;
  /** Called after a valid features.json write by an agent. */
  onFeaturesWritten?: () => void;
}

/** Wraps the core file tools with the mission rules; other tools pass through. */
export function protectTools(tools: Tool[], opts: ProtectOptions): Tool[] {
  return tools.map((t) => {
    const inner = t.run.bind(t);
    switch (t.name) {
      case "Read":
        return { ...t, async run(input, ctx) {
          const why = typeof input.path === "string" ? checkMissionPath(input.path, ctx.cwd, opts.role, "read") : null;
          return why ? refuse(why) : inner(input, ctx);
        } };
      case "Edit":
      case "Create":
        return { ...t, async run(input, ctx) {
          if (typeof input.path !== "string") return inner(input, ctx);
          const why = checkMissionPath(input.path, ctx.cwd, opts.role, "write");
          if (why) return refuse(why);
          const kind = isMissionJson(input.path, ctx.cwd);
          if (!kind) return inner(input, ctx);
          return guardedJsonWrite(inner, input, ctx, kind, opts);
        } };
      case "Grep":
      case "Glob":
        return { ...t, async run(input, ctx) {
          const target = typeof input.path === "string" && input.path ? input.path : ".";
          const why = checkMissionPath(target, ctx.cwd, opts.role, "read");
          if (why) return refuse(why);
          const out = await inner(input, ctx);
          return { ...out, content: filterProtectedLines(out.content, ctx.cwd) };
        } };
      case "Execute":
        return { ...t, async run(input, ctx) {
          const cmd = typeof input.command === "string" ? input.command : "";
          if (mentionsProtected(cmd)) return refuse("Refused: this command touches a mission system file (state.json, progress_log.jsonl or model-settings.json).");
          return inner(input, ctx);
        } };
      default:
        return t;
    }
  });
}

function mentionsProtected(cmd: string): boolean {
  if (!/missions/.test(cmd)) return false;
  return PROTECTED_MISSION_FILES.some((f) => cmd.includes(f));
}

function filterProtectedLines(text: string, cwd: string): string {
  const lines = text.split("\n");
  const kept = lines.filter((l) => {
    const m = PROTECTED_MISSION_FILES.find((f) => l.includes("/" + f) || l.startsWith(f));
    if (!m) return true;
    const first = l.split(":")[0];
    return checkMissionPath(first, cwd, "other", "read") === null;
  });
  return kept.join("\n");
}

async function guardedJsonWrite(inner: Tool["run"], input: Record<string, unknown>, ctx: ToolContext, kind: "features.json" | "validation-state.json", opts: ProtectOptions): Promise<ToolOutput> {
  const file = resolve(ctx.cwd, String(input.path));
  const existed = existsSync(file);
  const before = existed ? readFileSync(file) : undefined;
  const out = await inner(input, ctx);
  if (out.isError) return out;
  const text = (() => { try { return readFileSync(file, "utf8"); } catch { return ""; } })();
  const err = kind === "features.json" ? checkFeaturesJson(text) : checkValidationState(text);
  if (err) {
    if (before) writeFileSync(file, before); else { rmSync(file, { force: true }); mkdirSync(dirname(file), { recursive: true }); }
    return refuse(`${err}\nThe write was refused and the file was left as it was.`);
  }
  if (kind === "features.json") opts.onFeaturesWritten?.();
  return out;
}
