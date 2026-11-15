# Road to full parity with Factory's CLI and desktop app

Updated 2026-11-14. **Everything on this list is approved by the owner. Build all of it; leave nothing out.**
Hosted features are built as local versions (spec §20). Work in this order: group 1 blocks the rest. Within a
group, finish one item (tests green, decision logged, HANDOFF updated) before the next.

Two items need the owner to act, not only approve. Build the code anyway and ask the owner for the inputs:
- §20.2: the owner registers Rigwell's own OAuth clients with each provider and gives you the client IDs.
- §20.24: the owner buys the Apple Developer ID and Windows code-signing certificate and adds them as CI secrets.
Real-model runs (§20.1) need API keys from the owner, through the credential store, never committed.

## 1. Finish what is built (complete on 0260689)

1. Windows: `test/e2e/worktree.test.ts` "a setup profile runs with secrets stripped..." hangs (HANDOFF open issue 1).
2. Linux CI `desktop` job: two `test/desktop/electron-handlers.test.ts` tests (HANDOFF open issue 2).
3. Occasional flake in `test/desktop/electron-final.test.ts` (HANDOFF open issue 3).
4. All CI jobs green on one commit: Linux `test` and `desktop`, macOS, Windows.

## 2. Core features

5. `create_pr` and PR status, with `gh` and `glab` (spec §18.6, HANDOFF "Next task"). Complete on 4602ed6: 215 affected headless tests pass, all four CI jobs green.
6. **Workstreams, local** (spec §15.10, HANDOFF "Next task 2"). Complete through TUI on c6c6b64: all four CI jobs and platform packages green. The intermittent macOS restart file-listener cause remains unresolved and instrumented (decision 354).
7. Code-provider connections page for GitHub and GitLab (§20.21). Implemented on b0bb979, all four CI jobs and packages green; real device sign-in awaits the owner's public registered client IDs.
8. PR and semantic-diff review view, `/review` (§20.10). Delivered on c2a7847: all four CI jobs/packages green; native file-save cause unresolved and instrumented (360).

## 3. Agent quality (bounded live smoke verified; full comparisons remain)

9. Real-model smoke run on every adapter, including a free local model (§20.1). Bounded Windows coding task passed on both signed-in subscription clients and local Chat Completions. Workstream coordination also passed on both subscriptions (5f2e6ef). These do not establish every direct adapter's live coverage. Bedrock cannot be live-tested without an owner's account; its documented adapter/fake tests remain. Runtime model IDs are allowed outside Git.
10. A task suite of 40+ real coding tasks for `rigwell eval` (§20.1). Delivered on f32bc06: 43 graded tasks, six categories, all four CI jobs/packages green.
11. Head-to-head with the reference CLI on the same tasks and models, three trials each (spec 20.1). Machinery delivered on 52f145b, all four CI jobs/packages green. Real same-model/account comparison remains pending.
12. Tune prompts, tool descriptions, result shapes and guards until Rigwell matches on every model family (§20.1).
13. Settle every not-checked and unknown specification item with a real run or a logged decision (spec 20.1). Local choices recorded in decision 364 and docs/spec-clarifications.md; historical evidence remains intact. Real quality/release acceptance stays open under its own items. Delivered on 680bdd2, all four CI jobs/packages green.
14. Long-session checks: compaction, caching, cost, routing, guards, watchdog (§20.1).
15. Subscription sign-in with Rigwell's own OAuth clients (spec 20.2). Generic flows and guided setup implemented, including model/account configuration and Google token resolution; fake-service checks pass. Real built-in client registrations/sign-in remain pending the owner's registered IDs.

## 4. Connectors and tools

16. MCP OAuth (§20.3). Delivered on 2c8d082: resource/issuer discovery, PKCE/DCR or owned clients, URL-bound credentials, refresh, Connectors/settings and /mcp sign-in/out. Fake-service/headless checks and all four CI jobs/packages pass. Workstream missed notifications reconciled (374); deletion assertion aliases corrected (375).
17. Connector catalog (§20.4). Implemented: bundled public servers, search/categories, required values, credential references, OAuth start, explicit user sources fetched only on Catalog open. Affected 84 tests/438 assertions, both typechecks/headless build pass; delivered on 342ce8c with all four CI jobs/packages green.
18. Browser automation tools for the agent and the `agent-browser` skill (§20.5). Delivered on de2f47a, all four CI jobs and unsigned platform packages green. Separate elevated launch defect fixed; intermittent Windows navigation stall remains instrumented, with no root cause claimed.

## 5. Your other machines

19. Remote machines over SSH, including sessions, automations, mission workers and Workstream members on them,
    and the remote desktop viewer (§20.6). Implemented and headless affected checks green: owned startup recovery, complete selected-machine Files/Terminal, remote mission library handoff, persistent member restart/listener rearm and optional viewer. Delivered on d985672 with all four required CI jobs and unsigned packages green. No real remote-host or VNC screen acceptance claimed. See HANDOFF State and docs/machines.md.
20. Fleet management page and `rigwell machine` commands (§20.7).
21. Session sync between your machines, share and export, import (§20.8). Share/import delivered on b97f32d with all four CI jobs/packages green. Sync/leases delivered on eab2195 with all four CI jobs/packages green; see docs/sync.md.
22. Remote access from a phone with pairing (§20.9). Implemented locally: chosen-interface TLS, certificate identity, one-time QR/device revocation, mobile sessions/prompts/Workstreams and desktop settings; delivered on a9e03a6 with all four CI jobs and unsigned packages green. See docs/phone.md and HANDOFF State. Real phone/network acceptance remains.

## 6. Automations and delegation

23. GitHub, Slack, CI and chained triggers (§20.11). Implemented locally with durable event dispatch, explicit source replies and desktop controls; delivered on f47de1f with affected/final checks and all four required CI jobs/packages green. See docs/automation-triggers.md and HANDOFF State.
24. Slack and Teams delegation (§20.12). Implemented through normal daemon engines with shared Socket Mode, verified Bot Framework requests, source-bound prompts/replies and desktop controls; delivered on 8f05533 with affected/final checks and all four CI jobs/packages green. See docs/delegation.md and HANDOFF State.
25. Inbox page and email alerts (§20.13). Implemented locally with persisted six-category history, source routes and confirmed encrypted SMTP; delivered on 6578f32 with affected checks and all four required CI jobs/packages green. See docs/inbox.md and HANDOFF State.
26. Local code review, triage and QA services and their three skills (§20.16). Delivered on 1db4728: all four required CI jobs/packages green; see docs/local-services.md and HANDOFF State.

## 7. Knowledge, insight and extensibility

27. Plugins and marketplace indexes (§20.14). Delivered on 41cc384: all four required CI jobs/packages green; see docs/plugins.md and HANDOFF State.
28. Project wiki and the four wiki skills (§20.15). Delivered on 647cc35: all four required CI jobs/packages green; see docs/wiki.md and HANDOFF State.
29. Academy tutorials (§20.17). Delivered on 61ab39b with all four required CI jobs and unsigned packages green; see docs/academy.md and HANDOFF State.
30. Analytics page (§20.18). Delivered on f6aa8a4 with all four required CI jobs and unsigned packages green; see docs/analytics.md and HANDOFF State.
31. Evaluations page: history, side-by-side, judge graders, CSV/JSONL and Google Stax import (§20.19). Delivered on c32fba6 with all four required CI jobs and unsigned packages green. Stax explicit mapped CSV conversion is built, but real export compatibility remains unverified pending the owner file. See docs/evaluations.md and HANDOFF State.

## 8. Organization-style controls, locally (§20.20)

32. Policy file (org model and mission policies). Delivered on 289b7a0 with all four required CI jobs and unsigned packages green. See docs/policy.md and HANDOFF State.
33. Spend limits (plan usage limits and overage checks). Delivered on 2f326ef with all four required CI jobs and unsigned packages green. See docs/spend-limits.md and HANDOFF State.
34. Fallback model list (hosted fallback pool). Delivered on 5f019b6 with all four required CI jobs and unsigned packages green. See docs/fallback-models.md and HANDOFF State.
35. Profiles (the local stand-in for org members and the "role" field). Prepared with app/CLI selection, separate homes/keys/indexes, inherited policy and confirmed restart; affected 147/948 and final 19/155 PASS. Required CI pending. See docs/local-profiles.md and HANDOFF State.
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
