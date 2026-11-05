// `rigwell mcp login <name> | logout <name> | status`: OAuth sign-in for http and sse MCP servers in mcp.json.
import { AuthError, authManager } from "../auth/oauth.ts";
import { isFolderTrusted, loadSettings } from "../storage/settings.ts";
import { loadMcpConfig } from "./config.ts";
import { mcpHasToken, mcpLoginStart, mcpLogout, oauthEnabled } from "./oauth.ts";

const log = (m: string) => process.stderr.write(m + "\n");

export async function mcpMain(argv: string[], cwd = process.cwd()): Promise<number> {
  const [action, name] = argv;
  const usage = "usage: rigwell mcp <login <name> | logout <name> | status>";
  const user = loadSettings({ cwd, trusted: false }).settings;
  // An untrusted folder's project mcp.json is not read (spec 12.2), same as in a session.
  const { servers, warnings } = loadMcpConfig({ cwd, trustProject: isFolderTrusted(cwd, user.trustedFolders) });

  if (action === "status") {
    for (const w of warnings) log(`warning: ${w}`);
    const remote = servers.filter((s) => s.type !== "stdio");
    if (!remote.length) log("No http or sse MCP servers in mcp.json.");
    for (const s of remote) log(`${s.name}: ${!oauthEnabled(s) ? "OAuth off" : mcpHasToken(s) ? "signed in" : "not signed in"}`);
    return 0;
  }
  if (action === "logout") {
    if (!name) { log(usage); return 2; }
    log(mcpLogout(name) ? `signed out of ${name}` : `no stored sign-in for ${name}`);
    return 0;
  }
  if (action === "login") {
    if (!name) { log(usage); return 2; }
    const cfg = servers.find((s) => s.name === name);
    if (!cfg) { log(`no MCP server named ${name} in mcp.json${warnings.length ? ` (${warnings.join("; ")})` : ""}`); return 1; }
    try {
      log(`Finding the sign-in server for ${name} (${cfg.url})...`);
      const st = await mcpLoginStart(cfg);
      log(`Open this URL in your browser to sign in to ${name}:\n\n  ${st.url}\n\nWaiting for the redirect on this machine...`);
      const end = await authManager().waitLogin(st.loginId);
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
