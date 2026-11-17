# Ordered fallback models

Settings > Session Defaults includes an ordered fallback list. Enter exact configured model profile IDs, one per line. Save removes duplicates while preserving order; empty disables the extra pool. The main settings writer rejects malformed lists, more than 32 entries and `auto` recursion before writing. The equivalent user setting is:

```json
{
  "fallbackModels": ["custom:Backup-1", "custom:Reserve-2"]
}
```

The pool comes from user/managed settings outside the repository. Managed values take precedence, and repository/runtime project settings cannot replace this owner list. Existing engines retain their pool until rebuilt by a new or resumed connection. A configured fallback is explicit permission to send that session's conversation to that profile and use its adapter and tools; Rigwell never discovers a pool from available credentials or changes the default selected profile.

Each answer starts with the selected profile. Auto routing keeps its selected candidate and scored fallbacks first, then appends the owner pool without duplicate profiles. Normal same-model retries finish before the next candidate. Provider errors, exhausted rate limits and per-profile spend limits can advance the chain. Unknown/unavailable or policy-blocked pool entries are skipped without contacting them. An unknown primary selection is still an error. Overall spend limits, unknown overall historical cost, cancellation, owner budget/permission failures and ordinary non-provider errors stop the chain.

An unpriced prospective profile cannot make a capped request, but an explicitly configured priced fallback can proceed if historical overall spending is known and below its cap. Every candidate goes through the normal spend, adapter, model policy and tool restrictions. The request uses its candidate's tool mode, file-edit profile, context limits and adapter fields. Mode changes append a model-visible instruction and are treated as expected cache breaks. The transcript and usage accounting retain the profile that actually answered. The selected session model remains unchanged; live settings expose an effective fallback ID and user-only notices explain each switch without feeding failure text into model context.

Compaction summaries also try the owner pool, with summarizer limits rebuilt for each model and native synthesis kept read-only. An invalid summary does not mutate conversation history. Best-effort title/cache requests keep their existing behavior and spend guards. Explicit evaluator judges keep the selected judge and never substitute another grader.

Fallback is a new model request, not a transaction rollback. Partial failed requests can have consumed unreported usage, and native clients can already have performed work before failing. Existing provider retry and cancellation rules still apply. Local estimates and caps have the coverage limitations in [spend limits](spend-limits.md).

Acceptance uses actual protocol engines and fake providers for ordered retries, rate limits, script-mode tool execution, attribution, profile caps, overall stops, compaction, policy, cancellation and settings controls. The headless production page saves through the actual main settings writer, then a new engine uses the saved pool. No live provider or installed UI acceptance is claimed.
