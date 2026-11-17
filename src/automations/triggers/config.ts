export const GITHUB_EVENTS = ["issue_opened", "issue_labeled", "pr_opened", "pr_updated", "mention", "review_requested", "check_failed", "workflow_failed", "branch_pushed"] as const;
export type GithubEventKind = typeof GITHUB_EVENTS[number];
export type ExternalKind = "github" | "ci" | "slack" | "chained";
export interface GithubTrigger { repos: string[]; events: GithubEventKind[]; branch?: string; handle?: string; label?: string; pollMinutes?: number; transport?: "poll" | "webhook"; tokenCredential?: string }
export interface SlackTrigger { appTokenCredential: string; botTokenCredential: string; events: ("mention" | "dm" | "channel")[]; channels?: string[]; pattern?: string }
export interface ChainedTrigger { automationIds: string[]; status: "success" | "failure" | "any" }
export type EventTrigger = GithubTrigger | SlackTrigger | ChainedTrigger;
export const externalKind = (v: unknown): v is ExternalKind => ["github", "ci", "slack", "chained"].includes(String(v));
const strings = (v: unknown, max = 40): v is string[] => Array.isArray(v) && v.length > 0 && v.length <= max && v.every((s) => typeof s === "string" && s.length > 0 && s.length <= 200);
const ref = (v: unknown) => typeof v === "string" && /^[a-zA-Z0-9][\w.-]{0,63}$/.test(v);
export function validateEventTrigger(kind: ExternalKind, value: unknown): EventTrigger {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Configure the event trigger");
  const c = value as any;
  const keys = kind === "chained" ? ["automationIds", "status"] : kind === "slack" ? ["appTokenCredential", "botTokenCredential", "events", "channels", "pattern"] : ["repos", "events", "branch", "handle", "label", "pollMinutes", "transport", "tokenCredential"];
  if (Object.keys(c).some((k) => !keys.includes(k))) throw new Error("Unknown event trigger field");
  if (kind === "chained") {
    if (!strings(c.automationIds) || c.automationIds.some((s: string) => !/^[a-zA-Z0-9_-]+$/.test(s)) || !["success", "failure", "any"].includes(c.status)) throw new Error("Choose source automation IDs and a completion status");
  } else if (kind === "slack") {
    if (!ref(c.appTokenCredential) || !ref(c.botTokenCredential) || !strings(c.events, 3) || c.events.some((s: string) => !["mention", "dm", "channel"].includes(s))) throw new Error("Choose Slack credential names and events");
    if (c.channels !== undefined && (!strings(c.channels) || c.channels.some((s: string) => !/^[CDG][A-Z0-9]+$/.test(s)))) throw new Error("Use Slack channel IDs");
    if (c.events.includes("channel") && !c.channels?.length) throw new Error("Channel triggers need explicit channel IDs");
    if (c.pattern !== undefined && (typeof c.pattern !== "string" || c.pattern.length > 200)) throw new Error("Slack pattern must be at most 200 characters");
  } else {
    if (!strings(c.repos) || c.repos.some((s: string) => !/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(s)) || !strings(c.events, GITHUB_EVENTS.length) || c.events.some((s: string) => !GITHUB_EVENTS.includes(s as GithubEventKind))) throw new Error("Choose repository owner/name pairs and GitHub events");
    if (c.events.includes("branch_pushed") && (c.transport !== "webhook" || typeof c.branch !== "string" || !c.branch.trim())) throw new Error("Branch pushes require an exact branch and webhook transport");
    if (kind === "ci" && c.events.some((s: string) => !["check_failed", "workflow_failed"].includes(s))) throw new Error("CI triggers accept failed checks/workflows only");
    if (c.events.some((s: string) => ["check_failed", "workflow_failed"].includes(s)) && (typeof c.branch !== "string" || !c.branch.trim())) throw new Error("Choose the branch to watch for CI failures");
    for (const key of ["branch", "handle", "label"]) if (c[key] !== undefined && (typeof c[key] !== "string" || !c[key].trim() || c[key].length > 200 || /[\x00-\x1f]/.test(c[key]))) throw new Error(`Invalid ${key}`);
    if (c.events.includes("mention") && !/^[a-zA-Z0-9-]{1,39}$/.test(c.handle ?? "")) throw new Error("Mention triggers need a GitHub handle without @");
    if (c.pollMinutes !== undefined && (!Number.isInteger(c.pollMinutes) || c.pollMinutes < 1 || c.pollMinutes > 1440)) throw new Error("Poll interval must be 1 to 1440 minutes");
    if (c.transport !== undefined && !["poll", "webhook"].includes(c.transport)) throw new Error("Choose polling or webhook delivery");
    if (c.tokenCredential !== undefined && !ref(c.tokenCredential)) throw new Error("Use a stored GitHub credential name");
  }
  return structuredClone(c);
}
