# Road to full parity with Factory's CLI and desktop app

Updated 2026-11-14. **Everything on this list is approved by the owner. Build all of it; leave nothing out.**
Hosted features are built as local versions (spec §20). Work in this order: group 1 blocks the rest. Within a
group, finish one item (tests green, decision logged, HANDOFF updated) before the next.

Two items need the owner to act, not only approve. Build the code anyway and ask the owner for the inputs:
- §20.2: the owner registers Rigwell's own OAuth clients with each provider and gives you the client IDs.
- §20.24: the owner buys the Apple Developer ID and Windows code-signing certificate and adds them as CI secrets.
Real-model runs (§20.1) need API keys from the owner, through the credential store, never committed.

## 1. Finish what is built (blocking)

1. Windows: `test/e2e/worktree.test.ts` "a setup profile runs with secrets stripped..." hangs (HANDOFF open issue 1).
2. Linux CI `desktop` job: two `test/desktop/electron-handlers.test.ts` tests (HANDOFF open issue 2).
3. Occasional flake in `test/desktop/electron-final.test.ts` (HANDOFF open issue 3).
4. All CI jobs green on one commit: Linux `test` and `desktop`, macOS, Windows.

## 2. Core features

5. `create_pr` and PR status, with `gh` and `glab` (spec §18.6, HANDOFF "Next task").
6. **Workstreams, local** (spec §15.10, HANDOFF "Next task 2"). The feature the owner wanted Rigwell for.
7. Code-provider connections page for GitHub and GitLab (§20.21).
8. PR and semantic-diff review view, `/review` (§20.10).

## 3. Agent quality (the biggest gap; nothing measured yet)

9. Real-model smoke run on every adapter, including a free local model (§20.1).
10. A task suite of 40+ real coding tasks for `rigwell eval` (§20.1).
11. Head-to-head with Factory's CLI on the same tasks and models, three trials each (§20.1).
12. Tune prompts, tool descriptions, result shapes and guards until Rigwell matches on every model family (§20.1).
13. Settle every "not checked" and [UNKNOWN] item in the spec with a real run or a logged decision (§20.1).
14. Long-session checks: compaction, caching, cost, routing, guards, watchdog (§20.1).
15. Subscription sign-in with Rigwell's own OAuth clients (§20.2).

## 4. Connectors and tools

16. MCP OAuth (§20.3).
17. Connector catalog (§20.4).
18. Browser automation tools for the agent and the `agent-browser` skill (§20.5).

## 5. Your other machines

19. Remote machines over SSH, including sessions, automations, mission workers and Workstream members on them,
    and the remote desktop viewer (§20.6).
20. Fleet management page and `rigwell machine` commands (§20.7).
21. Session sync between your machines, share and export, import (§20.8).
22. Remote access from a phone with pairing (§20.9).

## 6. Automations and delegation

23. GitHub, Slack, CI and chained triggers (§20.11). Previously declined; now approved.
24. Slack and Teams delegation (§20.12).
25. Inbox page and email alerts (§20.13).
26. Local code review, triage and QA services and their three skills (§20.16).

## 7. Knowledge, insight and extensibility

27. Plugins and marketplace indexes (§20.14).
28. Project wiki and the four wiki skills (§20.15).
29. Academy tutorials (§20.17).
30. Analytics page (§20.18).
31. Evaluations page: history, side-by-side, judge graders, CSV/JSONL and Google Stax import (§20.19).

## 8. Organization-style controls, locally (§20.20)

32. Policy file (org model and mission policies).
33. Spend limits (plan usage limits and overage checks).
34. Fallback model list (hosted fallback pool).
35. Profiles (the local stand-in for org members and the "role" field).
36. Feature flags and a Labs page.
37. Mission readiness report.
38. Local crash reports and Report a bug (§20.22).
39. Workstream notification categories (§20.23).

## 9. Release readiness (§20.24)

40. Real macOS and Windows hardware tests: keychains, clipboards, terminals, notifications, tray, deep links.
41. Code signing and notarization in CI (owner supplies certificates).
42. Update feed on GitHub Releases; test install, update and rollback.
43. Installers, install docs, first-run check on a clean machine for each OS.

## Not applicable

Billing has no local meaning; Analytics and spend limits cover it (§20.20). Compaction and idle-stream rules for
Factory's own vendor-hosted models do not apply because Rigwell has no hosted models (§20.25).
