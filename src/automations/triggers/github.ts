import { codeProviderToken } from "../../auth/code-providers.ts";
import { secretValue } from "../../secrets/store.ts";
import type { GithubTrigger, GithubEventKind } from "./config.ts";
import type { TriggerEvent } from "./events.ts";
import { apiJson } from "./http.ts";

export interface GithubDeps { root?: string; fetch?: typeof fetch; token?: (config: GithubTrigger) => Promise<string | undefined> }
export class GithubTriggers {
  constructor(private deps: GithubDeps = {}) {}
  private async token(c: GithubTrigger) {
    if (this.deps.token) return this.deps.token(c);
    if (c.tokenCredential) { const token = secretValue(c.tokenCredential); if (!token) throw new Error(`Missing stored GitHub secret: ${c.tokenCredential}`); return token; }
    return codeProviderToken("github");
  }
  private async request(c: GithubTrigger, path: string, init: RequestInit, signal?: AbortSignal) { return apiJson((this.deps.root ?? "https://api.github.com") + path, await this.token(c), { ...init, headers: { "X-GitHub-Api-Version": "2022-11-28", ...init.headers } }, this.deps.fetch, signal); }
  async poll(c: GithubTrigger, since: number, signal?: AbortSignal): Promise<TriggerEvent[]> {
    const output: TriggerEvent[] = [], iso = new Date(since).toISOString();
    for (const repo of c.repos) {
      const root = `/repos/${repo}`;
      const pages = async (route: string, array?: string) => {
        const all: any[] = []; let bytes = 0;
        for (let page = 1; page <= 100; page++) {
          const { body, more } = await this.request(c, `${root}${route}${route.includes("?") ? "&" : "?"}per_page=100&page=${page}`, {}, signal);
          const rows = array ? body[array] : body; if (!Array.isArray(rows)) throw new Error("GitHub returned an invalid collection"); bytes += Buffer.byteLength(JSON.stringify(rows)); if (bytes > 8 * 1024 * 1024) throw new Error("GitHub backlog exceeds 8 MiB; use a narrower trigger or webhook"); all.push(...rows);
          if (route.startsWith("/pulls?") && rows.length && Date.parse(rows.at(-1).updated_at) < since) return all;
          if (!more) return all;
          if (page === 100) throw new Error("GitHub backlog exceeds 100 pages; use a narrower trigger or webhook");
        }
        return all;
      };
      const add = (kind: GithubEventKind, id: string, at: unknown, payload: any, issue?: number) => {
        const time = Date.parse(String(at)); if (!c.events.includes(kind) || !Number.isFinite(time) || time < since) return;
        output.push({ id: `github:${repo}:${kind}:${id}`, kind, at: time, payload: { repo, ...payload }, ...(Number.isSafeInteger(issue) && issue! > 0 ? { reply: { service: "github" as const, repo, issue: issue! } } : {}) });
      };
      if (c.events.includes("issue_opened")) for (const row of await pages(`/issues?state=all&since=${encodeURIComponent(iso)}`)) if (!row.pull_request) add("issue_opened", String(row.id), row.created_at, row, row.number);
      if (c.events.includes("issue_labeled") || c.events.includes("review_requested")) for (const row of await pages("/issues/events")) {
        if (row.event === "labeled" && (!c.label || row.label?.name === c.label)) add("issue_labeled", String(row.id), row.created_at, row, row.issue?.number);
        if (row.event === "review_requested" && (!c.handle || row.requested_reviewer?.login?.toLowerCase() === c.handle.toLowerCase())) add("review_requested", String(row.id), row.created_at, row, row.issue?.number);
      }
      if (c.events.some((s) => s === "pr_opened" || s === "pr_updated")) for (const row of await pages("/pulls?state=all&sort=updated&direction=desc")) {
        add("pr_opened", String(row.id), row.created_at, row, row.number);
        if (row.updated_at !== row.created_at) add("pr_updated", `${row.id}:${row.updated_at}`, row.updated_at, row, row.number);
      }
      if (c.events.includes("mention")) for (const row of await pages(`/issues/comments?since=${encodeURIComponent(iso)}&sort=updated&direction=asc`)) {
        const handle = c.handle!.toLowerCase(); if (!(String(row.body ?? "").toLowerCase().match(/@[a-z0-9-]+/g) ?? []).some((v: string) => v === `@${handle}`)) continue;
        const issue = Number(/\/issues\/(\d+)$/.exec(String(row.issue_url))?.[1]); add("mention", `${row.id}:${row.updated_at}`, row.updated_at, row, issue);
      }
      if (c.events.includes("check_failed")) for (const row of await pages(`/commits/${encodeURIComponent(c.branch!)}/check-runs?filter=all`, "check_runs")) if (row.status === "completed" && ["failure", "timed_out", "action_required", "startup_failure"].includes(row.conclusion)) add("check_failed", `${row.id}:${row.completed_at}`, row.completed_at, { ...row, branch: c.branch }, row.pull_requests?.[0]?.number);
      if (c.events.includes("workflow_failed")) for (const row of await pages(`/actions/runs?branch=${encodeURIComponent(c.branch!)}&status=failure&created=${encodeURIComponent(">=" + iso)}`, "workflow_runs")) add("workflow_failed", `${row.id}:${row.run_attempt ?? 1}`, row.updated_at, row, row.pull_requests?.[0]?.number);
    }
    return output.sort((a, b) => a.at - b.at || a.id.localeCompare(b.id));
  }
  webhook(c: GithubTrigger, event: string, body: any, receivedAt = Date.now()): TriggerEvent[] {
    const repo = body?.repository?.full_name;
    if (!c.repos.includes(repo)) return [];
    if (event === "push") {
      if (!c.events.includes("branch_pushed") || !c.branch || body.ref !== `refs/heads/${c.branch}` || body.deleted !== false || !/^[a-f0-9]{40}$/.test(body.after ?? "") || /^0+$/.test(body.after) || !/^[a-f0-9]{40}$/.test(body.before ?? "")) return [];
      return [{ id: `github:${repo}:push:${body.before}:${body.after}`, kind: "branch_pushed", at: receivedAt, payload: body, reply: { service: "github_commit", repo, sha: body.after } }];
    }
    const action = body.action, issue = body.issue ?? body.pull_request; let kind: GithubEventKind | undefined, at: string | undefined, key: string | undefined;
    if (event === "issues" && action === "opened") { kind = "issue_opened"; at = issue?.created_at; key = String(issue?.id); }
    if (event === "issues" && action === "labeled" && (!c.label || c.label === body.label?.name)) { kind = "issue_labeled"; at = issue?.updated_at; key = `${issue?.id}:${body.label?.name}:${at}`; }
    if (event === "pull_request" && action === "opened") { kind = "pr_opened"; at = issue?.created_at; key = String(issue?.id); }
    if (event === "pull_request" && ["synchronize", "edited", "reopened"].includes(action)) { kind = "pr_updated"; at = issue?.updated_at; key = `${issue?.id}:${at}`; }
    if (event === "pull_request" && action === "review_requested" && (!c.handle || body.requested_reviewer?.login?.toLowerCase() === c.handle.toLowerCase())) { kind = "review_requested"; at = issue?.updated_at; key = `${issue?.id}:${body.requested_reviewer?.login ?? body.requested_team?.slug}:${at}`; }
    if (event === "issue_comment" && ["created", "edited"].includes(action) && (String(body.comment?.body ?? "").toLowerCase().match(/@[a-z0-9-]+/g) ?? []).some((v: string) => v === `@${c.handle?.toLowerCase()}`)) { kind = "mention"; at = body.comment?.updated_at; key = `${body.comment?.id}:${at}`; }
    if (event === "check_run" && action === "completed" && ["failure", "timed_out", "action_required", "startup_failure"].includes(body.check_run?.conclusion) && body.check_run?.check_suite?.head_branch === c.branch) { kind = "check_failed"; at = body.check_run.completed_at; key = `${body.check_run.id}:${at}`; }
    if (event === "workflow_run" && action === "completed" && body.workflow_run?.conclusion === "failure" && body.workflow_run.head_branch === c.branch) { kind = "workflow_failed"; at = body.workflow_run.updated_at; key = `${body.workflow_run.id}:${body.workflow_run.run_attempt ?? 1}`; }
    if (!kind || !c.events.includes(kind) || !Number.isFinite(Date.parse(at ?? ""))) return [];
    const number = issue?.number ?? body.check_run?.pull_requests?.[0]?.number ?? body.workflow_run?.pull_requests?.[0]?.number;
    return [{ id: `github:${repo}:${kind}:${key}`, kind, at: Date.parse(at!), payload: body, ...(Number.isSafeInteger(number) && number > 0 ? { reply: { service: "github", repo, issue: number } as const } : {}) }];
  }
  async reply(c: GithubTrigger, event: TriggerEvent, text: string, signal?: AbortSignal) {
    if (event.reply?.service === "github_commit") {
      const { repo, sha } = event.reply;
      if (!c.repos.includes(repo) || !/^[a-f0-9]{40}$/.test(sha)) throw new Error("No verified GitHub reply destination");
      await this.request(c, `/repos/${repo}/commits/${sha}/comments`, { method: "POST", body: JSON.stringify({ body: text }) }, signal);
      return;
    }
    const target = event.reply; if (target?.service !== "github" || !c.repos.includes(target.repo) || !Number.isSafeInteger(target.issue) || target.issue < 1) throw new Error("No verified GitHub reply destination");
    await this.request(c, `/repos/${target.repo}/issues/${target.issue}/comments`, { method: "POST", body: JSON.stringify({ body: text }) }, signal);
  }
}
