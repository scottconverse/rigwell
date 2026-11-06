// API keys / secrets, environments and OAuth sign-in pages (docs/auth.md). Pure helpers; the pages call the protocol methods.

export const SECRET_NAME = /^[A-Za-z0-9._-]{1,64}$/;
export const VAR_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

export interface SecretRow { name: string; mask: string; createdAt: number; updatedAt: number; usedBy: string[] }

export function validateSecret(name: string, value: string, existing: string[], replacing: boolean): string | null {
  if (!SECRET_NAME.test(name)) return "Names use 1 to 64 letters, digits, dots, dashes or underscores.";
  if (!replacing && existing.includes(name)) return `A secret named ${name} already exists. Use Replace to change its value.`;
  if (!value) return "Enter the value to store.";
  return null;
}

/** Text for the delete confirmation: environments that still point at the secret will show it as missing. */
export function deleteWarning(s: Pick<SecretRow, "name" | "usedBy">): string {
  return s.usedBy.length ? `${s.name} is used by ${s.usedBy.join(", ")}. Those environments will show it as missing.` : `Delete ${s.name}? This cannot be undone.`;
}

// ---- environments

export type EnvVarRow = { name: string; kind: "literal"; value: string } | { name: string; kind: "secret"; secret: string; missing?: boolean };
export interface EnvironmentRow { name: string; description?: string; updatedAt: number; vars: EnvVarRow[] }

/** The `vars` object for set_environment. Throws a readable message for a bad row. */
export function varsToParam(rows: EnvVarRow[]): Record<string, string | { secret: string }> {
  const out: Record<string, string | { secret: string }> = {};
  for (const r of rows) {
    if (!VAR_NAME.test(r.name)) throw new Error(`"${r.name}" is not a valid variable name (letters, digits, underscore; no leading digit).`);
    if (r.name in out) throw new Error(`${r.name} is listed twice.`);
    if (r.kind === "secret") { if (!r.secret) throw new Error(`Choose a secret for ${r.name}.`); out[r.name] = { secret: r.secret }; } else out[r.name] = r.value;
  }
  return out;
}

export const DEFAULT_ENV_ROW: EnvVarRow = { name: "", kind: "literal", value: "" };

// ---- OAuth sign-in

export interface ProviderRow {
  name: string; loggedIn: boolean; expiresAt?: number; expired?: boolean; hasRefreshToken?: boolean; scopes: string[]; apiBaseUrl?: string; browserLogin: boolean; deviceLogin: boolean;
}
export interface LoginStatus {
  loginId: string; name: string; kind: "browser" | "device"; state: "pending" | "complete" | "failed" | "cancelled"; expiresAt?: number; url?: string; userCode?: string; verificationUri?: string; verificationUriComplete?: string; error?: string;
}

export function providerStatus(p: ProviderRow, now = Date.now()): string {
  if (!p.loggedIn) return "Signed out";
  if (p.expired && !p.hasRefreshToken) return "Signed in, expired";
  if (p.expiresAt) return `Signed in until ${new Date(p.expiresAt).toLocaleString()}`;
  return "Signed in";
}

/** Which sign-in the button starts: browser when the provider has one, otherwise the device code flow. */
export const defaultMode = (p: Pick<ProviderRow, "browserLogin" | "deviceLogin">): "browser" | "device" => (p.browserLogin ? "browser" : "device");

/** Polls auth_login_status until it leaves "pending". `sleep` is injected for tests. */
export async function pollLogin(get: () => Promise<LoginStatus>, o: { sleep?: (ms: number) => Promise<void>; intervalMs?: number; maxMs?: number; onUpdate?: (s: LoginStatus) => void; cancelled?: () => boolean } = {}): Promise<LoginStatus> {
  const sleep = o.sleep ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms)));
  const interval = o.intervalMs ?? 1500;
  const max = o.maxMs ?? 5 * 60_000 + 10_000;
  let waited = 0;
  for (;;) {
    const s = await get();
    o.onUpdate?.(s);
    if (s.state !== "pending") return s;
    if (o.cancelled?.()) return { ...s, state: "cancelled" };
    if (waited >= max) return { ...s, state: "failed", error: "Timed out waiting for the sign-in to finish." };
    await sleep(interval);
    waited += interval;
  }
}

/** Which sign-in buttons an MCP server row shows (from list_mcp_servers). */
export const mcpAuthButtons = (s: { requiresAuth?: boolean; hasAuthTokens?: boolean }) => ({ signIn: !!s.requiresAuth, signOut: !!s.hasAuthTokens });

// ---- Chrome cookie import

export function filterDomains(list: { domain: string; count: number }[], q: string): { domain: string; count: number }[] {
  const t = q.trim().toLowerCase();
  return t ? list.filter((d) => d.domain.includes(t)) : list;
}
export const importSummary = (r: { imported: number; skipped: number }) =>
  `Imported ${r.imported} cookie${r.imported === 1 ? "" : "s"}${r.skipped ? `; ${r.skipped} could not be decrypted or set and were skipped` : ""}.`;
