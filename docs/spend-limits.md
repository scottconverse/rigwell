# Local spend limits

Settings > Usage provides daily and monthly USD caps, overall and per model profile ID, plus a warning fraction. Blank removes a cap; zero prevents new requests. Save validates before writing user settings. The table shows effective settings, including managed overrides. Refresh and configuration make no model requests.

```json
{
  "spendLimits": {
    "dailyUsd": 5,
    "monthlyUsd": 50,
    "warnAt": 0.8,
    "models": {
      "custom:Example-0": { "dailyUsd": 2 }
    }
  }
}
```

These are illustrative amounts. Prices are explicit `analytics.prices` estimates, editable on the same page; see [Analytics](analytics.md) for the fields and accounting coverage. Missing or invalid prices refuse a capped request rather than treating it as free. An explicit zero estimate can represent a local endpoint or subscription token charge, but does not measure subscription limits or billing. Current configured prices also estimate historical usage. Repository configuration cannot change these controls or prices.

Periods use UTC calendar days and months. The existing incremental session index counts dated own usage across local sessions, including child engines, routing, compaction, cache warmup, titles and evaluator judges. Judges retain only usage in the accounting session, without judge prompts or evidence. Copied fork history is not counted twice. Undated legacy counters, unreported failed requests, deleted history and remote machines cannot establish actual billing; coverage is shown explicitly. Dated unpriced usage makes the relevant cap unknown and blocks further requests until its price is configured.

Every Session checks admission before claiming execution ownership and checks again before constructing a model adapter, including auxiliary requests. Reaching the warning fraction emits a user-only note once per scope, cap, status and UTC day in that Session. A completed response is retained when it crosses a cap; subsequent admissions or model requests stop. Separate evaluator requests use the same guard and accounting. Per-model caps on other profiles do not block the selected profile. The local owner API `get_spend_status` reads the same effective estimates without launching work.

This is a limit on new work based on recorded estimates, not a provider billing ceiling. Requests already in flight, concurrent requests and retries may finish above a cap. No cost forecast or reservation is invented. An already running native subscription client owns its internal tools and requests; Rigwell checks its next invocation and records reported aggregate usage. Changing a cap cannot revoke work already sent to that client.

Acceptance uses temporary stores, fake providers, actual Session engines, an evaluator and the production Usage controls connected to a real daemon in headless Chromium. No real-provider or installed desktop billing acceptance is claimed.
