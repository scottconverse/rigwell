# Local Analytics

Open **Analytics** from the desktop sidebar or command palette. The page refreshes the existing local SQLite session index from transcripts and settings. It never calls a model, sends telemetry, starts an automation or contacts a provider. Explicit session sync and sharing remain separate user-controlled features. Remote replicas are not counted until explicitly restored into this machine's active session storage.

Group tokens, estimated USD cost, tool attempts and turn times by UTC day, model profile id, project folder or session id. Optional inclusive UTC start/end dates and exact model/project/session filters apply to the accounting rows. Refresh reads newly completed transcript lines. Empty results and unknown values are shown explicitly. Bars show the first fifty groups; the table and CSV retain every group.

New sessions append small accounting records for completed answer requests, routing classifiers, compaction summaries, cache warmups and generated titles, and for completed/interrupted/failed turn duration. Existing transcript records already establish Rigwell tool attempts and results, including Script inner calls and native coordination calls through Rigwell. Each attempt includes permission denials/errors; a tool attempt does not prove that its command executed. Native adapters additionally consume structured native tool start/result events without recording arguments or output. They do not infer tool outcomes from displayed activity text. Native bridge calls are excluded from native metrics because their actual Rigwell calls are already recorded. Interrupted or unreported results stay unknown. Failure rate divides failures by successes plus failures, excluding unknowns. Tool attempts use their start date and latest known result. Turn duration includes tool execution and user waits, and is not CPU time.

Tokens add uncached input, output, cache read and cache creation. Thinking tokens are included in output and are displayed separately without adding them again. Cache hit rate is cache read divided by all input-side tokens. Usage not reported by a failed provider request is unavailable. This view is accounting evidence, not a provider billing statement.

Price estimates use explicit `analytics.prices` in user settings, keyed by model profile id:

```json
{
  "analytics": {
    "prices": {
      "custom:Example-0": {
        "inputPerMtok": 1,
        "outputPerMtok": 2,
        "cachedInputPerMtok": 0.2,
        "cacheWritePerMtok": 1.5
      }
    }
  }
}
```

All values are nonnegative USD per million tokens. Cache-write price defaults to uncached input price. These are example values, not published provider prices. An explicit all-zero price can represent a local endpoint's token charge. Missing or invalid prices stay unknown, with a separate known-price subtotal and unpriced token count. Subscription fees are not converted into guessed token prices. The current configured price estimates historical usage too; no historical price feed is fetched.

Each child session contributes only its own usage, never the parent's inclusive child totals. New transcript forks mark copied records and baseline counters so history is not counted as new execution. Old forks without that boundary exclude uncertain copied tools and legacy totals; their new dated usage establishes a boundary for subsequent recorded observations. Older unforked session counters not covered by accounting events appear as undated, model-unattributed usage. Date filters exclude it and disclose the excluded observation count. Historical model/day attribution, old native-tool outcomes, deleted history and unreported usage cannot be reconstructed. The page discloses malformed transcript lines skipped by the index. Rebuilding the cache regenerates the same accounting from source files.

Automation success uses retained run attempts, at most fifty records per automation. Success divided by success plus failure excludes cancelled and in-progress runs, which are listed separately. Retries are attempts, not distinct triggers. Project/model/session filters omit automation rates because per-run attribution is not reliably stored. Mission worker success uses the latest terminal outcome per worker session, dividing success by success plus partial plus failure; paused workers are excluded. Current completed/other mission states are shown by their update date. There is no terminal failed mission state, so the page does not invent a mission failure percentage. Project/session filters can select missions; model filters omit them.

**Export CSV** exports the selected grouping, tool rows, outcomes, totals, filters and coverage to a user-chosen local `.csv` path. It includes profile ids and project paths, but no prompts, tool arguments, outputs, keys or raw failure messages. Text is quoted, embedded quotes/newlines are preserved and leading spreadsheet formulas are escaped. The main process revalidates every cell before saving, refuses a wrong extension and caps exports at 16 MiB. Cancel writes nothing. Export does not upload the file.

Tests use fake adapters and native clients, temporary session stores and the headless production page connected to a real daemon. These checks do not establish real-provider billing accuracy or installed desktop save-dialog behavior.

The Analytics page also shows four badges (First Steps, Regular, Long Haul, Weekend Builder). They count your own sessions on this machine, not automation runs, subagents, forks, workstream members, mission workers or evaluation trials. Time is active time; a pause of more than 30 minutes ends a stretch.
