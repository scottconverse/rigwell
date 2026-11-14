# Road to full parity with Factory's CLI and desktop app

Written 2026-11-14. Work through the groups in order. Group 1 blocks the rest; group 3 is where most of the real
parity gap is. Items marked **owner decision** need Scott's yes or no before anyone builds them.

## 1. Finish what is built (blocking)

1. Windows: `test/e2e/worktree.test.ts` "a setup profile runs with secrets stripped..." hangs (HANDOFF open issue 1).
2. Linux CI `desktop` job: two `test/desktop/electron-handlers.test.ts` tests (HANDOFF open issue 2).
3. Occasional flake in `test/desktop/electron-final.test.ts` (HANDOFF open issue 3).
4. All CI jobs green on one commit: Linux `test` and `desktop`, macOS, Windows.

## 2. Approved, not built

5. `create_pr` and PR status (spec §18.6, HANDOFF "Next task").
6. **Workstreams, local** (spec §15.10). This is the feature the owner wanted Rigwell for. Build it right after
   `create_pr`, or before it if the CI fixes are done and `create_pr` is blocked.

## 3. Agent quality (not measured yet; the biggest gap)

Every test so far uses scripted fake model servers, so the machinery is proven but the agent is not.

7. Smoke run against real models on every adapter: Anthropic, OpenAI (HTTP and WebSocket), Gemini, Bedrock, and a
   Chat Completions endpoint (a local model such as Ollama costs nothing). Needs keys from the owner.
8. A real coding-task suite for `rigwell eval` (bug fixes, features, refactors, terminal tasks; a public
   benchmark-style set is fine).
9. Run the same suite with Factory's CLI and with Rigwell on the same models and compare pass rate, cost and time.
10. Tune Rigwell's own system prompts, tool descriptions and per-model settings until the scores match. Write new
    text; never copy Factory's.
11. Check on long real sessions: compaction, prompt caching, cost reporting, routing, guards and the loop watchdog.
    The spec has about 17 "not checked" and 2 [UNKNOWN] items; settle each with a real run or log a decision.
12. Subscription sign-in: the OAuth code is generic and ships no client IDs (decision 267). For one-click
    subscription sign-in, register Rigwell's own OAuth app with each provider that allows third-party apps, then
    ship those IDs. **Owner decision:** which providers, under whose account.

## 4. Factory features left out of the spec that a solo user would notice

Each needs an **owner decision**. Recommendation in brackets.

13. MCP OAuth: sign in to hosted MCP servers (many connectors need it; today a 401 just fails). [Yes]
14. A built-in connector catalog: a curated list of MCP servers to add with one click. [Yes, small]
15. Browser automation skill (`agent-browser` was left out because Rigwell has no bundled browser CLI). The desktop
    browser pane exists; this would give the agent a headless browser too. [Yes]
16. Remote machines: run sessions or Workstream members on another of your own computers over SSH, in place of
    Factory's cloud computers. [Later, after Workstreams]
17. Session sync and share links between your own machines. [Later]
18. Remote access: drive the desktop app from your phone. [Later]
19. PR and semantic-diff review view in the desktop app. [Maybe, after `create_pr`]
20. GitHub-event and Slack-message triggers for automations. [Declined by the owner; listed only for completeness]
21. Marketplace for sharing skills and agents. [No]

## 5. Team and org features (skip for a solo build)

Org billing and members, fleet management, org model and mission policies, plan usage limits and the hosted model
pool, Teams delegation, hosted inbox and email alerts, wiki, academy, analytics, hosted evaluations, remote feature
flags. None of these matter to one person working locally.

## 6. Release readiness

22. Test on real macOS and Windows machines, not only CI: OS keychains, clipboards, terminals, notifications, tray.
23. Code signing and notarization: an Apple Developer account for macOS and a code-signing certificate for Windows.
    **Owner decision** (they cost money).
24. Host the update feed and test the electron-updater install path end to end.
25. Install docs and a first-run check on a clean machine for each OS.
