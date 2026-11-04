// Answers built by the permission and question panels (spec 13.4, 5.5.7). Pure, so they can be unit tested.

export const OTHER_LABEL = "Other...";

/** request_permission answer: the chosen option, the optional comment, and the edited plan with proceed_edit. */
export function permissionAnswer(option: string, o: { comment?: string; editedSpec?: string } = {}): { selectedOption: string; comment?: string; editedSpecContent?: string } {
  const comment = o.comment?.trim();
  return {
    selectedOption: option,
    ...(comment ? { comment } : {}),
    ...(option === "proceed_edit" && o.editedSpec !== undefined ? { editedSpecContent: o.editedSpec } : {}),
  };
}

/** One ask_user answer: ticked options joined by ", ", plus the "Other..." text when that box is used. */
export function answerText(selected: string[], other: string | null): string {
  const t = other?.trim();
  return [...selected, ...(t ? [t] : [])].join(", ");
}

/** The questions as the panel shows them: Yes/No when there are no options. */
export function questionOptions(q: { options?: string[] }): string[] {
  return q.options?.length ? q.options : ["Yes", "No"];
}
