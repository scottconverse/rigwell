import { join } from "node:path";
import { loadSettings } from "../storage/settings.ts";
import { loadOrgSettings } from "../storage/org.ts";
import { sandboxFor } from "../sandbox/controller.ts";
import { contains, mergeSandboxOrg } from "../sandbox/policy.ts";
import { resolvedBrowserPath } from "./paths.ts";
import { allowedBrowserRequest } from "./network.ts";
export { resolvedBrowserPath } from "./paths.ts";

export function browserPolicy(sessionId: string, cwd: string) {
  const merged = mergeSandboxOrg(loadOrgSettings()?.settings.sandbox, loadSettings({ cwd }).settings.sandbox);
  const policy = sandboxFor(sessionId).policy(cwd);
  const allowed = merged.network?.allowedDomains ?? (merged.enabled ? [] : ["*"]);
  const denied = merged.network?.deniedDomains ?? [];
  const canWrite = (p: string) => {
    const target = resolvedBrowserPath(p);
    return policy.writable.some((r) => contains(resolvedBrowserPath(r), target)) && ![...policy.readOnly, ...policy.unreadable].some((r) => contains(resolvedBrowserPath(r), target));
  };
  const canRequest = (value: string) => allowedBrowserRequest(value, allowed, denied);
  if (!/^[A-Za-z0-9_-]+$/.test(sessionId)) throw new Error("Invalid browser session identity");
  return { allowed, denied, canRequest, canWrite, writable: policy.writable, blockedPaths: [...policy.readOnly, ...policy.unreadable], directory: join(cwd, ".rigwell", "browser", sessionId) };
}
export type BrowserPolicy = ReturnType<typeof browserPolicy>;


export function browserUrl(raw: unknown): string {
  if (raw === undefined) return "about:blank";
  if (typeof raw !== "string") throw new Error("url must be a string");
  if (raw === "about:blank") return raw;
  const url = new URL(raw);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) throw new Error("Browser URLs must use HTTP or HTTPS without embedded credentials");
  return url.toString();
}
