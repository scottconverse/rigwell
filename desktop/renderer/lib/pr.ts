// Create PR and the PR status chip for the worktree list (spec 18.6). The harness asks before it pushes
// (request_permission, confirmationType create_pr); this file turns that ask into a yes or no from a dialog.

export interface PrDetails { branch: string; base: string; remote?: string; title: string; body: string; draft?: boolean }

/** The connection's onRequest for a create_pr call: a create_pr permission goes to `confirm`; anything else is a no. */
export function prRequestHandler(confirm: (d: PrDetails) => Promise<boolean>) {
  return async (method: string, params: Record<string, any>): Promise<unknown> => {
    const use = params.toolUses?.[0];
    if (method !== "request_permission" || use?.confirmationType !== "create_pr") return method === "request_permission" ? { selectedOption: "cancel" } : {};
    return { selectedOption: (await confirm(use.details as PrDetails)) ? "proceed_once" : "cancel" };
  };
}

export interface PrStatusResult {
  state: "none" | "open" | "merged" | "closed";
  number?: number;
  url?: string;
  draft?: boolean;
  checks?: { total: number; passed: number; failed: number; pending: number; state: "none" | "passing" | "failing" | "pending" };
}

/** Chip text and tone for a PR status; null when the branch has no PR. */
export function prChip(s: PrStatusResult | null | undefined): { text: string; tone: "ok" | "warn" | "bad" | "muted" } | null {
  if (!s || s.state === "none") return null;
  const n = s.number ? `#${s.number}` : "PR";
  if (s.state === "merged") return { text: `${n} merged`, tone: "muted" };
  if (s.state === "closed") return { text: `${n} closed`, tone: "muted" };
  const c = s.checks;
  const checks = !c || c.state === "none" ? "" : c.state === "passing" ? ` · checks pass (${c.passed}/${c.total})` : c.state === "failing" ? ` · ${c.failed} failing` : ` · ${c.pending} running`;
  return { text: `${n} ${s.draft ? "draft" : "open"}${checks}`, tone: c?.state === "failing" ? "bad" : c?.state === "pending" ? "warn" : "ok" };
}
