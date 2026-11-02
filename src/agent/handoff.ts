// Spec handoff (spec 5.5.7, 3.1.8): "hand off to a new session". The approved spec is stored as a handoff record; the
// new session starts with the spec as its brief.
//
// Protocol (Rigwell):
//  - The ExitSpecMode prompt offers proceed_new_session, proceed_new_session_low|medium|high when the connection has a
//    client that can answer prompts. Its details carry `contextSavingsPercent` and `supportsClientStartedHandoff: true`.
//  - The answer to a handoff option carries `clientStartsHandoffSession: true`. The harness then saves the spec, writes the
//    record, ends the old turn with reason `spec_handoff`, and sends a `spec_handoff` notification
//    {specHandoffId, autonomyLevel, title, specPath, contextSavingsPercent}.
//  - The client starts the new session with initialize_session {cwd, specHandoffId}. The harness loads the record, uses
//    the brief as the first user message, applies the record's autonomy level and starts the turn.
// Records live in $RIGWELL_HOME/state/spec-handoffs/<id>.json and are read once per new session (they stay on disk).
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { AutonomyLevel } from "../core/types.ts";
import { rigwellHome } from "../storage/paths.ts";

export interface SpecHandoff {
  id: string;
  plan: string;
  title: string;
  specPath?: string;
  autonomyLevel: AutonomyLevel;
  cwd: string;
  fromSessionId: string;
  createdAt: string;
}

const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isHandoffId = (v: unknown): v is string => typeof v === "string" && ID.test(v);

const dir = () => path.join(rigwellHome(), "state", "spec-handoffs");

export function saveHandoff(h: SpecHandoff): void {
  mkdirSync(dir(), { recursive: true });
  writeFileSync(path.join(dir(), `${h.id}.json`), JSON.stringify(h, null, 2) + "\n");
}

export function loadHandoff(id: string): SpecHandoff | null {
  if (!isHandoffId(id)) return null;
  try {
    const j = JSON.parse(readFileSync(path.join(dir(), `${id}.json`), "utf8"));
    if (j && typeof j.plan === "string" && typeof j.title === "string") return j as SpecHandoff;
  } catch { /* missing or unreadable */ }
  return null;
}

/** The first user message of the new session. */
export function handoffBrief(h: SpecHandoff): string {
  return (
    `You are starting a new session to carry out a plan the user already approved. The planning conversation is not part of this session; the plan below is your brief.\n` +
    `Title: ${h.title}\n` + (h.specPath ? `Saved at: ${h.specPath}\n` : "") +
    `\n<approved-plan>\n${h.plan}\n</approved-plan>\n\n` +
    `Check the files before you rely on a detail in the plan, then carry it out.`
  );
}

/** Share of the current context a new session does not have to carry (0 to 100). */
export function contextSavingsPercent(planTokens: number, contextTokens: number): number {
  if (contextTokens <= 0) return 0;
  return Math.max(0, Math.min(100, Math.round(100 * (1 - planTokens / contextTokens))));
}

/** proceed_new_session[_low|_medium|_high] -> the autonomy level for the new session; null for any other value. */
export function handoffLevel(option: string | undefined): AutonomyLevel | null {
  const m = /^proceed_new_session(?:_(low|medium|high))?$/.exec(option ?? "");
  return m ? ((m[1] as AutonomyLevel | undefined) ?? "off") : null;
}
