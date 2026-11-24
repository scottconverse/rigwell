// One list of pages for the sidebar More menu, the command palette and the Settings search.
export interface NavPage { id: string; label: string; route: string; palette: string }

/** Pages in the sidebar More menu. New Session, Automations, Search and Mission Control stay on the sidebar. */
export const MORE_PAGES: NavPage[] = [
  { id: "inbox", label: "Inbox", route: "/inbox", palette: "Go to Inbox" },
  { id: "workstreams", label: "Workstreams", route: "/workstreams", palette: "Go to Workstreams" },
  { id: "review", label: "Review", route: "/review", palette: "Go to Review" },
  { id: "machines", label: "Machines", route: "/machines", palette: "Go to Machines" },
  { id: "imports", label: "Import session", route: "/imports", palette: "Import shared session" },
  { id: "sync", label: "Sync", route: "/sync", palette: "Sync between machines" },
  { id: "plugins", label: "Plugins", route: "/plugins", palette: "Go to Plugins" },
  { id: "wiki", label: "Wiki", route: "/wiki", palette: "Go to Wiki" },
  { id: "analytics", label: "Analytics", route: "/analytics", palette: "Go to Analytics" },
  { id: "eval", label: "Evaluations", route: "/eval", palette: "Go to Evaluations" },
];

/** Every page the command palette can open. */
export const PALETTE_PAGES: NavPage[] = [
  { id: "home", label: "Home", route: "/", palette: "Home" },
  { id: "missions", label: "Mission Control", route: "/missions", palette: "Go to Mission Control" },
  { id: "automations", label: "Automations", route: "/automations", palette: "Go to Automations" },
  ...MORE_PAGES,
  { id: "academy", label: "Academy", route: "/academy", palette: "Go to Academy" },
];

export interface SettingsPage { id: string; label: string; icon: string; words: string }

/** All Settings pages. `icon` is an SVG path on a 16 by 16 grid. `words` are the main options on the page, for search. */
export const SETTINGS_PAGES: SettingsPage[] = [
  { id: "general", label: "General", icon: "M2 4h12M2 8h12M2 12h12M5 2.5v3M10 6.5v3M6 10.5v3", words: "language file previews keep awake sleep updates update feed public key tray icon shortcuts" },
  { id: "appearance", label: "Appearance", icon: "M8 2a6 6 0 1 0 0 12a6 6 0 0 0 0-12zM8 2v12", words: "theme dark light accent color contrast font size diff view reduce motion startup background" },
  { id: "notifications", label: "Notifications and sounds", icon: "M4 11V7a4 4 0 0 1 8 0v4l1 1H3zM7 14h2", words: "alerts finished needs input sound volume bell chime subagent" },
  { id: "email-alerts", label: "Email alerts", icon: "M2 4h12v8H2zM2 4l6 5 6-5", words: "mail inbox smtp notify" },
  { id: "session-defaults", label: "Session Defaults", icon: "M3 2h10v12H3zM5.5 5.5h5M5.5 8h5M5.5 10.5h3", words: "model reasoning mode autonomy spec compaction token limit check threshold" },
  { id: "missions", label: "Missions", icon: "M4 14V2M4 3h8l-2 3 2 3H4", words: "orchestrator worker validator scrutiny user testing machine remote repository model reasoning" },
  { id: "delegation", label: "Slack and Teams", icon: "M2 3h12v8H7l-3 3v-3H2z", words: "delegation chat bot messages" },
  { id: "custom-models", label: "Custom Models", icon: "M8 2l5 3v6l-5 3-5-3V5zM3 5l5 3 5-3M8 8v6", words: "provider endpoint base url context window model" },
  { id: "machines", label: "Remote machines", icon: "M2 3h12v8H2zM6 14h4M8 11v3", words: "ssh host server computer" },
  { id: "worktrees", label: "Worktrees", icon: "M5 2v12M11 4v2a3 3 0 0 1-3 3H5", words: "git branch folder keep at most new sessions cleanup" },
  { id: "connectors", label: "Connectors", icon: "M6 2v4M10 2v4M4 6h8v2a4 4 0 0 1-8 0zM8 12v2", words: "mcp server tools catalog integrations" },
  { id: "session-management", label: "Session Management", icon: "M2 3h12v3H2zM3 6v7h10V6M6.5 9h3", words: "archive unarchive rename delete bulk" },
  { id: "usage", label: "Usage", icon: "M3 14V9M8 14V3M13 14V6", words: "tokens cost spend limit budget context meter" },
  { id: "api-keys", label: "API keys", icon: "M10 2a4 4 0 1 1-3.5 6L2 12.5V14h2.5v-1.5H6V11l1.5-1.5", words: "secret credentials provider token" },
  { id: "environments", label: "Environments", icon: "M6 2H4v12h2M10 2h2v12h-2", words: "variables env setup container" },
  { id: "accounts", label: "Accounts", icon: "M8 2a3 3 0 1 1 0 6a3 3 0 0 1 0-6zM2.5 14a5.5 5 0 0 1 11 0", words: "sign in login provider subscription" },
  { id: "profiles", label: "Local profiles", icon: "M2 3h12v10H2zM5 6.5h2M9.5 6h2.5M9.5 9h2.5M4 10a2 2 0 0 1 4 0", words: "profile import export settings" },
  { id: "labs", label: "Labs", icon: "M6 2h4M7 2v4l-4 7a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1L9 6V2", words: "experimental preview features" },
  { id: "code-providers", label: "Code providers", icon: "M6 4L2 8l4 4M10 4l4 4-4 4", words: "github gitlab repository pull request" },
  { id: "voice", label: "Voice dictation", icon: "M6 3a2 2 0 0 1 4 0v5a2 2 0 0 1-4 0zM3.5 8a4.5 4.5 0 0 0 9 0M8 12.5V14", words: "speech to text microphone command model language endpoint" },
  { id: "phone-access", label: "Phone access", icon: "M5 2h6v12H5zM7.5 12h1", words: "mobile remote pair qr" },
  { id: "support", label: "Support", icon: "M8 2a6 6 0 1 0 0 12a6 6 0 0 0 0-12zM6.2 6.3a1.9 1.9 0 1 1 2.7 1.7c-.6.3-.9.7-.9 1.4M8 11.5v.1", words: "diagnostics logs restart background service help" },
];

/** True when every typed word appears in the page name or its option words. */
export function matchesSettings(page: SettingsPage, query: string): boolean {
  const hay = `${page.label} ${page.words}`.toLowerCase();
  return query.toLowerCase().split(/\s+/).filter(Boolean).every((w) => hay.includes(w));
}
