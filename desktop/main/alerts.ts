// Notification and sound policy (spec §19.2, §19.3). Pure decisions from an attention event, the settings and the
// window state; the main process performs them (Notification, badge, sound playback in the renderer).
import type { AttentionEvent } from "../../src/sidepane/attention.ts";
import type { DesktopSettings, SoundValue } from "./settings.ts";

export interface WindowState {
  /** An app window has OS focus. */
  focused: boolean;
  /** Session id shown in the focused window, if any. */
  viewingSessionId?: string;
}

export interface NotifyAction {
  /** Newer notifications with the same tag replace older ones. */
  tag: string;
  title: string;
  body: string;
  /** Click opens this route. */
  route: string;
}

export function notificationFor(ev: AttentionEvent, s: DesktopSettings, w: WindowState): NotifyAction | undefined {
  if (ev.kind !== "attention_requested" || ev.cancelled) return undefined;
  const needs = ev.category === "questions_and_approvals" || ev.category === "mission_needs_input" || ev.requestKind === "workstream_attention";
  const finished = ev.category === "agent_turn_complete" || ev.category === "mission_complete";
  if (needs && !s.notifications.needsInput) return undefined;
  if (finished && !s.notifications.finished) return undefined;
  if (!needs && !finished) return undefined;
  // Skip the toast when the user is already looking at that session.
  if (w.focused && w.viewingSessionId === ev.sessionId) return undefined;
  return {
    tag: ev.workstreamId ? `workstream-${ev.workstreamId}-${ev.agentId ?? "budget"}` : `session-${ev.sessionId}`,
    title: ev.failed ? "Stopped with a problem" : needs ? "Needs your input" : "Finished",
    body: ev.summary,
    route: ev.workstreamId ? `/workstreams/${ev.workstreamId}` : `/sessions/${ev.sessionId}`,
  };
}

/** Number shown on the app badge: sessions with an unanswered request. */
export function badgeCount(openRequests: Iterable<AttentionEvent>): number {
  const sessions = new Set<string>();
  for (const e of openRequests) if (e.kind === "attention_requested" && (e.requestKind === "permission" || e.requestKind === "ask_user" || e.requestKind === "mission_attention" || e.requestKind === "workstream_attention")) sessions.add(e.workstreamId ?? e.sessionId);
  return sessions.size;
}

export type SoundAction = { kind: "bell"; volume: number } | { kind: "builtin"; id: "ok" | "ack"; volume: number } | { kind: "file"; path: string; volume: number };

function toAction(v: SoundValue, volume: number): SoundAction | undefined {
  if (v === "off") return undefined;
  if (v === "bell") return { kind: "bell", volume };
  if (v === "ok" || v === "ack") return { kind: "builtin", id: v, volume };
  if (typeof v === "object" && v && typeof v.file === "string") return { kind: "file", path: v.file, volume };
  return undefined;
}

/** Which sound to play for an event, or undefined. `nested` marks events from subagents (quiet mode: bell only). */
export function soundFor(ev: AttentionEvent, s: DesktopSettings, w: WindowState, nested = false): SoundAction | undefined {
  if (ev.kind !== "attention_requested" || ev.cancelled) return undefined;
  const snd = s.sounds;
  if (snd.soundFocusMode === "focused" && !w.focused) return undefined;
  if (snd.soundFocusMode === "unfocused" && w.focused) return undefined;
  let value: SoundValue;
  if (ev.requestKind === "permission" || ev.requestKind === "ask_user" || ev.requestKind === "mission_attention" || ev.requestKind === "workstream_attention") value = snd.awaitingInputSound;
  else if (ev.requestKind === "session_completion" || ev.requestKind === "mission_completion") value = snd.completionSound;
  else return undefined;
  if (nested) {
    if (snd.subagentSounds === "off") return undefined;
    return value === "off" ? undefined : { kind: "bell", volume: snd.soundVolume };
  }
  return toAction(value, snd.soundVolume);
}
