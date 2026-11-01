# Droid desktop app: inventory and diff against `harness-spec.md`

Walked Oct 31 2026, logged-in Factory desktop app 1.0.0 (build 87a2b3a, Electron 42.3.3), Pro plan, Windows.
Every screen and settings page was opened and read. View only: no messages sent, no settings saved.
Names below describe what the app does; they are not text for our product (§11 of the spec: no Factory/Droid branding).

Statuses were updated after Scott chose **B, local product clone** (Oct 31 2026) and §14–§19 were added to the spec.

**Status key**

| Status | Meaning |
|---|---|
| **Covered** | The spec describes it well enough to build. |
| **Partial** | The spec has part of it (a key, field or protocol), but not all of the screen or behavior. |
| **Missing** | Not in the spec, and in scope. |
| **Later phase** | Hosted-only; listed under "Later phases" in §1 and not in this build. |
| **Ask Scott** | Seen in the app but outside the agreed scope; on the §1 approval list or marked "ask Scott". |
| **Out** | Excluded in §1 ("Still out": PR / semantic-diff review UI, marketplace). |

## Summary

The spec now covers the engine (§2–§13) plus everything in the app that runs on the user's machine (§14–§19). What is left is hosted (later phases) or waits on Scott's approval.

Rows counted by their first status (some rows are split, e.g. "Covered (MCP); Later phase (hosted catalog)"):

| Area | Covered | Partial | Missing | Later phase | Ask Scott |
|---|---|---|---|---|---|
| Desktop shell (window, sidebar, palette, menus) | 8 | 0 | 0 | 1 | 0 |
| Session screen and composer | 12 | 0 | 0 | 0 | 2 |
| Side pane (files, terminal, browser, side chat) | 4 | 0 | 0 | 0 | 0 |
| Missions | 6 | 1 | 0 | 1 | 0 |
| Automations | 3 | 0 | 0 | 0 | 3 |
| Settings, account | 14 | 1 | 0 | 6 | 3 |
| Settings, organization | 0 | 0 | 0 | 5 | 0 |
| **Total (70 rows)** | **47** | **2** | **0** | **13** | **8** |

No row is **Out**: the PR / diff review UI and the marketplace were not separate screens in this app.

---

## 1. Desktop shell

| Item | What the app has | Spec | Status |
|---|---|---|---|
| App form | Electron desktop app; title bar with sidebar toggle, back/forward, Update badge | §14.1 processes and transport, §14.2 windows | **Covered** |
| Sidebar | New Session (Ctrl+N), Mission Control, Automations, Search; Projects list; user name + settings gear | §14.3 | **Covered** |
| Projects list | Projects group sessions (title + age). Filter menu: last activity (30 days), type, project, computer, group by project, sort recent/manual. Row menu: Archive Project; `+` = new session in that project. Add-folder icon | §14.3 (the "computer" filter is hosted, left out) | **Covered** |
| Command palette (Ctrl+K; Search opens it too) | Search sessions, pages, settings, actions. Tabs: All, Sessions, Pages, Settings, Actions. Recent sessions across projects; Create New Session / Mission; Go to Mission Control / Automations; Toggle Terminal (Ctrl+J); Open Tools Panel (Alt+Ctrl+B). Look-back filter 7d / 30d / 90d / All | §14.3 | **Covered** |
| Home screen | Wordmark; machine chip; folder chip; composer | §14.3 | **Covered** |
| Machine chip | Local ●; environments (`droid-environment`, Default); + New environment; Droid Computers ▸ | §14.3 shows "Local" only; environments and cloud computers are hosted | **Later phase** |
| Folder chip | Search; recent project paths; + Add new project | §14.3, trust prompt §5.6 | **Covered** |
| Menu bar | File: New Window (Ctrl+Shift+N), Settings (Ctrl+,), Copy CLI install command, Check for Updates, Exit. Edit: standard. View: Reload, Force Reload, zoom, Full Screen (F11). Window: Minimize (Ctrl+M), Close (Ctrl+W). Help: a network item (label not fully read; not checked), Report a bug, About | §14.2 | **Covered** |
| Auto-update | Update badge; Check for Updates | §14.5 (own feed) | **Covered** |

## 2. Session screen and composer

| Item | What the app has | Spec | Status |
|---|---|---|---|
| Transcript | User bubbles; tool-call rows (icon, tool name, main argument); markdown with tables, code, links | §3 data; §14.3 desktop rendering; §13 TUI | **Covered** |
| Session header menu | Share, Pin, Rename, Archive, Open Machine Terminal, Copy Working Directory, Copy Session ID, Copy Session Link, Copy as Markdown | §14.3 (Share is hosted: later phase) | **Covered** |
| Composer | "What would you like to work on?"; Esc Esc clears; Esc stops | §13.3, §14.3 | **Covered** |
| Attach (`+`) | Opens the OS file picker | §14.3; images per §3.1 | **Covered** |
| Model chip | Searchable picker with a gear. "Auto Model (Dynamic)" first; a pinned short list; then grouped by provider. Each model shows a **cost multiplier** (e.g. 0.04x–4.8x); unavailable models greyed | §14.3 model picker; relative cost from your own model table [DESIGN] | **Covered** |
| Model shortcut | Settings bind Ctrl+N to the model picker; the sidebar labels Ctrl+N as New Session | §13.3 and §14.3: our app uses Ctrl+N for New Session [DESIGN]; which wins in Factory's app is in §10 | **Covered** |
| Autonomy chip | Click cycles **Low → Medium → High** (Off is not in the cycle). Tooltips: Low "edits and read-only commands", Medium "allow reversible commands", High "allow all commands". Ctrl+L. Bars show level | §5.5, §13.3, §14.3; Ctrl+L key behavior still in §10 | **Covered** |
| Mode chip | Normal, Spec ("research and plan before changes"), Mission ("long-horizon, Droids in parallel") | §5.5, §14.3, Missions §15 | **Covered** |
| Reasoning | Tab cycles reasoning level | §13.3 | **Covered** |
| Connectors chip | Dialog: search; Your Connectors (count, Refresh, Browse connectors); MCP Servers (count, "edit `~/.factory/mcp.json`", Add MCP Server) | §5.7, §14.3 (hosted connector catalog: later phase) | **Covered** (MCP) |
| Skills chip | Dialog: search; tabs All / Personal / Built-in; list + rendered SKILL.md preview. Personal skills came from `~/.agents/skills` on this machine | §5.8 loading; §14.3 dialog | **Covered** |
| Built-in skills (23) | agent-browser, tuistory, detect-overlapping-workstreams, init, migrate, install-code-review, install-triage, review, simplify, session-navigation, pdf-document, powerpoint, excel, word-document, install-qa, security-review, deep-security-review, incident, wiki, wiki-video-gen, install-wiki, browse-wiki, visualize | §1 approval list (also decides agent-browser for §17.3 and the readiness commands in §15.7) | **Ask Scott** |
| `?` help | "Shortcuts & Modes": palette, clear, stop, modes, autonomy meanings, shortcut list | §13.3, §14.3 | **Covered** |
| Voice dictation | Mic button; Ctrl+Shift+D | §1 approval list | **Ask Scott** |

## 3. Side pane (tools panel)

Toggled from the top right (Alt+Ctrl+B). Tabbed; `+` adds a tab; can be maximized.

| Tab | What the app has | Spec | Status |
|---|---|---|---|
| Files (Ctrl+P) | Workspace tree with search and a settings gear; file viewer; "Open in VS Code" with an editor dropdown | §17.1 (viewer internals in §10) | **Covered** |
| Terminal (Ctrl+J) | Shell on the session's computer | §17.2 | **Covered** |
| Browser (Shift+Ctrl+B) | Preview local and web pages | §17.3 (Chrome cookie import: ask Scott) | **Covered** |
| Side chat (Alt+Ctrl+S) | Ask a question without interrupting the main session | §17.4 | **Covered** |

## 4. Missions

| Item | What the app has | Spec | Status |
|---|---|---|---|
| Mission Control page | Header + New Mission; tabs All / Running / Paused / Completed; empty state | §15.1 states, §15.8 protocol and UI, §14.3 | **Covered** |
| New Mission dialog | Steps: describe goal → review/approve plan → features run autonomously → validation at milestones. Concepts: Orchestrator, Workers, Milestones. Warnings: not for simple tasks, runs hours/days, much higher token use | §15.1, §15.4, §15.8 | **Covered** |
| Repository readiness check | Non-git folder → "Repository not agent-ready" warning (cannot judge validation ability); Cancel / Proceed Anyway | §15.7 (local file only [DESIGN]) | **Covered** |
| Mission model roles (settings) | Orchestrator, Worker, Validator, each with model + reasoning | §15.4 | **Covered** |
| Milestone gates (settings) | Skip scrutiny; Skip user testing | §15.7 | **Covered** |
| Mission skills bucket | – | §5.8 bucket; §15.1 (which built-in mission skills ship: ask Scott) | **Covered** (loading) |
| Plan / worker / validation screens | Not seen: no mission was run (would spend usage) | §15.8 data and TUI views; desktop screens are an open item in §10 | **Partial** (not checked) |
| Billing rule | Missions need Extra Usage on the Pro plan (from an earlier session in the app) | Hosted billing; §15.6 pauses on a provider billing error instead [DESIGN] | **Later phase** |

## 5. Automations

| Item | What the app has | Spec | Status |
|---|---|---|---|
| Automations page | Refresh; + New automation; GitHub connect banner for CI automations; tabs Private / Shared; search; filter | §16.7 (GitHub triggers: ask Scott; shared automations are hosted) | **Covered** |
| Model | Automation = prompt + one trigger. Triggers: **schedule, Slack message, GitHub event (PR, push), webhook**. Each run is a full session you can open and continue | §16.2 schedule, §16.5 local webhook, §16.4 runs; Slack and GitHub triggers on the §1 approval list | **Covered** (schedule, webhook); **Ask Scott** (Slack, GitHub) |
| Setup | From a template, or describe it to the agent in a setup chat; change it later by telling the agent | §16.7 create form; guided "create by chatting" is optional (§16.8) | **Ask Scott** |
| Templates: 16 use cases | Ticket to PR, Daily Status Digest, Meeting Notes Sync, Slack Digest, Channel Q&A, PR Reviewer, Code Health, Scheduled Error Triage, Slack Bug Fixer, Slack Ticket Filer, Webhook Alert Responder, CI Failure Triage, New Issue Investigator, Review Comment Fixer, Test Coverage, Docs Refresh | §16.8 (which templates ship: Scott's call) | **Ask Scott** |
| Templates: 7 guided setups | Triage, PR Babysitter, Incident Response, Code Review, QA, AutoWiki, Security Audit (each has its own setup form) | §16.8 | **Ask Scott** |
| Automation skills bucket | – | §5.8 bucket; §12.2 automation skills folder; §16.1 | **Covered** |

## 6. Settings, account

| Page | What the app has | Spec | Status |
|---|---|---|---|
| General: account, org, code providers | GitHub, GitLab, Azure DevOps connections | §14.3: hosted | **Later phase** |
| General: preferences | Language, role, loading statuses, auto-open file previews, keep running with screen off | §14.3, §14.4 `keepAwakeEnabled` (the role field is hosted) | **Covered** |
| General: shortcuts | Toggle spec (Shift+Tab), cycle reasoning (Tab), model selector (Ctrl+N), cycle autonomy (Ctrl+L), dictation (Ctrl+Shift+D); each can be switched off | §13.3, §14.3 (dictation: ask Scott) | **Covered** |
| General: cloud sync | Sync session contents | §1 later phases | **Later phase** |
| General: notifications, email, sounds | Desktop alerts (finished / needs input); automation alert emails; volume, completion and input sounds, focus mode, subagent sounds | §19.2, §19.3 (email alerts: later phase) | **Covered** |
| Appearance | System/Light/Dark; per-theme import/copy, presets, accent/background/foreground/bubble colors, contrast; UI/content/code fonts and sizes; diff view (unified, wrap, +/- markers); reduce motion | §19.4 (theme file format [DESIGN]); TUI keeps light/dark only (§13.7) | **Covered** |
| API Keys | Create keys that act as the user and bill to them | §1 approval list | **Ask Scott** |
| Connectors | 59 hosted integrations, 10 categories, search/filter/sort, featured (Linear, Jira, Slack, Datadog); some need Configure | MCP servers covered (§5.7, §14.3); the hosted catalog is a later phase | **Later phase** |
| Session Management | Active / Archived; search; filters (project, last updated, computer, session type); bulk-select table; rename / archive | §14.3, §12.1 | **Covered** |
| Droid Computers | This computer (editable name, Local); Remote Control toggle; your computers; managed cloud computers (+ Create) | §1 later phases (remote machines) | **Later phase** |
| Secrets | Runtime credentials for managed computers; personal / org; write-only values | §1 approval list | **Ask Scott** |
| Environments | Cards: default, ready, repos, base image, org, build time; + New environment | §1 approval list | **Ask Scott** |
| Session Defaults: model, reasoning, mode, autonomy | Auto Model; reasoning; Auto / Spec; Off / Low / Medium (default) / High | `sessionDefaultSettings` (§12.2) | **Covered** |
| Session Defaults: image model | Image model for an image-generation tool | `imageGenerationModel` key only; no image tool in §5 | **Partial** |
| Session Defaults: fallback model | "Core" open-weight model used when standard usage runs out | §1 later phases (hosted fallback pool) | **Later phase** |
| Session Defaults: spec mode | Model, reasoning, save folder (user home / project / custom) | §5.5 spec mode, `specSaveDir` | **Covered** |
| Session Defaults: compaction | Token limit 250K (100K–1M); per-model overrides; compaction model; threshold toggle | §4.4; compaction keys (§12.2) | **Covered** |
| Session Defaults: subagent models | Subagent autonomy (inherit / levels); Light / Medium / Heavy tiers, each model + reasoning | §5.9; `subagentModelSettings` (§12.2) | **Covered** |
| Session Defaults: delegations | Delegation machine, model, reasoning, custom instructions | §1 later phases (Slack/Teams delegation) | **Later phase** |
| Missions | See §4 above | §15.4 | **Covered** |
| Custom Models (BYOK) | Form / JSON; providers Anthropic, OpenAI, Bedrock, OpenRouter, Ollama, Other; auth (key, env var, credential helper, none); API format (Anthropic Messages, OpenAI Responses, Chat Completions); base URL, token limits, thinking, effort, image override, headers, extra args | §4.6 fields; §14.3 form | **Covered** |
| Worktrees | Folder (`~/.factory/worktrees`); ephemeral limit 15 with auto-cleanup; setup profiles (local, shared in `.factory/worktree-setups/`); managed worktrees per computer | §18 (managed worktrees on other computers: later phase) | **Covered** |
| Usage | Limits for standard usage and the fallback pool: 5-hour, weekly, monthly %; managed-computer hours; Extra Usage purchase; org choice when limits run out | §14.3 local token totals (plan limits are hosted) | **Covered** (local totals) |
| Support | Version, build, connection ("Self-hosted"), Electron version; docs, contact; diagnostics + copy diagnostics | §14.3, §14.5 | **Covered** |

## 7. Settings, organization

| Page | What the app has | Spec | Status |
|---|---|---|---|
| Organization | App permissions (code providers for personal tasks); org code providers | §14.3: org pages are hosted (the `org` settings layer in §12.2 stays) | **Later phase** |
| Members | Invite, search/filter, role, status | §1 later phases | **Later phase** |
| Fleet | Read-only: computers, remote control, environment instances; stats; table | §1 later phases | **Later phase** |
| Delegations | Slack (@tag), Teams, Linear (assign), Jira (assign) set up per org; agent profiles | §1 later phases | **Later phase** |
| Billing | Plan, price, change/cancel, payment method, extra usage, vouchers | §1 later phases | **Later phase** |

---

## Findings folded into the spec

1. **Ctrl+N**: Factory's app binds it to both the model picker and New Session. The spec now picks New Session for our app (§13.3, §14.3) [DESIGN]; which wins in Factory's app is in §10.
2. **Autonomy cycling**: clicking the chip cycles Low → Medium → High and skips Off (§13.3, §14.3). Ctrl+L was not pressed; still in §10.
3. **Built-in skills**: the app ships 23. Which ship in our product is on the §1 approval list.
4. **Personal skills** load from `~/.agents/skills` on this machine, which matches §5.8.
5. **Model cost multipliers**: §14.3 shows relative cost from your own model table [DESIGN].
6. **Fallback model** when usage runs out is part of the hosted usage pool: later phase (§1).

## Not checked

- Help menu first item (only "…network…" was readable).
- Terminal, Browser and Side chat tabs were listed but not opened (the spec for them comes from code, §17).
- Ctrl+L key behavior.
- Mission plan, worker and validation screens; automation create form; environment create form; share dialog. Opening these needs a run or a save, which would spend usage or change settings.

## Side effects of the walk

- Clicking the autonomy chip changed the new-session draft from Medium to High. I cycled it back to Medium and checked the tooltip.
- "Open" in the Files tab opened VS Code on `rea-work`. Nothing was edited.
- The New Mission dialog was cancelled. No messages were sent. No settings were saved.

---

## Decided: B, local product clone (Oct 31 2026)

Scott chose B: add everything that runs on the user's machine (desktop app, Missions, local automations with schedule and webhook triggers, side pane, connectors via MCP, worktrees, notifications, appearance) and keep hosted-only parts as later phases. The spec does this in §1 and §14–§19, with build phases 8–11 in §9.

**Waiting on Scott's approval** (not in the build until approved; listed in §1):

- voice dictation;
- which of the 23 built-in skills ship (this also decides the agent-browser skill for the browser pane and the readiness-report / readiness-fix commands);
- GitHub-event and Slack-message automation triggers;
- API keys, secrets and environments pages;
- which automation templates ship, if any.

**Optional extras** (marked "ask Scott" where they appear): tray icon (§14.2), Chrome cookie import in the browser pane (§17.3), `create_pr` and PR status (§18.6), per-automation `VISUAL.html` and the guided "create by chatting" setup (§16.8).
