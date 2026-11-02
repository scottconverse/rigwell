// `rigwell auth login <name> [--device] | logout <name> | status`
import { loadSettings } from "../storage/settings.ts";
import { parseOAuthProviders } from "./config.ts";
import { AuthError, authManager } from "./oauth.ts";

const log = (m: string) => process.stderr.write(m + "\n");

export async function authMain(argv: string[], cwd = process.cwd()): Promise<number> {
  const [action, name, ...rest] = argv;
  const usage = "usage: rigwell auth <login <name> [--device] | logout <name> | status>";
  const { settings } = loadSettings({ cwd });
  const { providers, problems } = parseOAuthProviders(settings.oauthProviders);
  const mgr = authManager();

  if (action === "status") {
    for (const p of problems) log(`warning: ${p}`);
    const rows = mgr.list(providers.values());
    if (!rows.length) log("No OAuth providers configured (see docs/auth.md: settings key oauthProviders).");
    for (const r of rows) {
      const state = !r.loggedIn ? "not signed in" : r.expired ? (r.hasRefreshToken ? "expired (refreshes on next use)" : "expired (sign in again)") : `signed in${r.expiresAt ? `, expires ${new Date(r.expiresAt).toISOString()}` : ""}`;
      log(`${r.name}: ${state}`);
    }
    return 0;
  }
  if (action === "logout") {
    if (!name) { log(usage); return 2; }
    log(mgr.logout(name) ? `signed out of ${name}` : `no stored sign-in for ${name}`);
    return 0;
  }
  if (action === "login") {
    if (!name) { log(usage); return 2; }
    const cfg = providers.get(name);
    if (!cfg) { log(`no OAuth provider named ${name} in oauthProviders${problems.length ? ` (${problems.join("; ")})` : ""}`); return 1; }
    try {
      const st = await mgr.loginStart(cfg, rest.includes("--device") ? "device" : undefined);
      if (st.kind === "browser") log(`Open this URL in your browser to sign in to ${name}:\n\n  ${st.url}\n\nWaiting for the redirect on this machine...`);
      else log(`To sign in to ${name}, open ${st.verificationUriComplete ?? st.verificationUri} and enter the code ${st.userCode}\n\nWaiting...`);
      const end = await mgr.waitLogin(st.loginId);
      if (end.state === "complete") { log(`signed in to ${name}`); return 0; }
      log(`sign-in failed: ${end.error ?? end.state}`);
      return 1;
    } catch (e) {
      log(`sign-in failed: ${e instanceof AuthError ? e.message : (e as Error).message}`);
      return 1;
    }
  }
  log(usage);
  return 2;
}
