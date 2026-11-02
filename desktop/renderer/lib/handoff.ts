// Spec handoff (spec 5.5.7, 3.1.8, decision 274) as the desktop shows it. Pure functions.

export interface PermissionOption { label: string; value: string }

export const isHandoffOption = (value: string) => value.startsWith("proceed_new_session");

/** The options of an ExitSpecMode prompt, with "(N% context saved)" on the handoff ones. */
export function specOptions(options: PermissionOption[], contextSavingsPercent: unknown): PermissionOption[] {
  const saved = typeof contextSavingsPercent === "number" ? ` (${Math.round(contextSavingsPercent)}% context saved)` : "";
  return options.map((o) => (isHandoffOption(o.value) ? { ...o, label: o.label + saved } : o));
}

/** The answer to a spec prompt: handoff options also say that this client opens the new session itself. */
export function specAnswer(option: string, o: { comment?: string; editedSpec?: string } = {}): { selectedOption: string; comment?: string; editedSpecContent?: string; clientStartsHandoffSession?: true } {
  const comment = o.comment?.trim();
  return {
    selectedOption: option,
    ...(comment ? { comment } : {}),
    ...(option === "proceed_edit" && o.editedSpec !== undefined ? { editedSpecContent: o.editedSpec } : {}),
    ...(isHandoffOption(option) ? { clientStartsHandoffSession: true as const } : {}),
  };
}

export interface HandoffState { specHandoffId?: string; turnEnded?: boolean }

/**
 * Follows the spec_handoff notification and the turn that ends with reason spec_handoff; returns the id to start once both
 * were seen (in either order), so the new session never races the old session's last writes.
 */
export function nextHandoff(state: HandoffState, n: { type?: string; specHandoffId?: unknown; reason?: unknown }): { state: HandoffState; start?: string } {
  let st = state;
  if (n.type === "spec_handoff" && typeof n.specHandoffId === "string") st = { ...st, specHandoffId: n.specHandoffId };
  else if (n.type === "agent_turn_completed" && n.reason === "spec_handoff") st = { ...st, turnEnded: true };
  else return { state };
  return st.specHandoffId && st.turnEnded ? { state: {}, start: st.specHandoffId } : { state: st };
}
