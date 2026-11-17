import { domainAllowed } from "../sandbox/policy.ts";
export function allowedBrowserRequest(value: string, allowed: string[], denied: string[]): boolean {
  try {
    const u = new URL(value);
    if (["about:", "data:", "blob:"].includes(u.protocol)) return true;
    return ["http:", "https:", "ws:", "wss:"].includes(u.protocol) && !u.username && !u.password && domainAllowed(u.hostname, allowed, denied).ok;
  } catch { return false; }
}
