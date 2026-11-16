# Next-version list

This is the tracked list of owner-requested work for the version after the shipped 0.4.0 release. The next version number is not assigned. These items do not change current release scope or acceptance. Record future requests here rather than adding them to the current release checklist.

## NV-001: Optional hosted Stax workflow

- Requested by the owner on 2026-11-15.
- Status: planned for next-version investigation; no implementation started.
- Outcome to evaluate: offer Google's hosted Stax as an option alongside Rigwell's existing local Evaluations feature. Preserve the existing option.
- Owner context: Google offers both an open-source Stax application and a hosted service; the owner identifies the hosted service as free to use.
- Determine the practical user workflow, any data exchange needed and the implementation effort before selecting an approach. The owner has not selected an embedded view, external browser workflow or direct service connection.
- Full integration of Google's open-source application is explicitly excluded from the current release.
- Prior source comparison: [Stax and Rigwell evaluations](stax-comparison.md). It is a source-level comparison; the signed-in hosted service has not been evaluated.
- Owner-supplied pricing context is retained under [Information to know about Stax](stax-comparison.md#information-to-know-about-stax): free beta platform access, separate BYOK inference costs, free-tier API options and possible future platform pricing. This does not authorize paid model calls or change the current subscription route.

## NV-002: Later open-source Stax integration assessment

- Requested by the owner on 2026-11-15 as a later assessment.
- Status: deferred; no integration approved or started.
- Assess how much work it would take to reuse or integrate Google's open-source Stax code, including its fit with Rigwell's local packaging, model execution and existing coding-task evaluator.
- Keep this assessment distinct from NV-001's hosted option. Do not assume adopting the full application is the chosen approach.
- Schedule and implementation decisions remain for a later owner discussion. This is not a blocker for the current release.

## NV-003: DevHarmonics integration proposal withdrawn

- Cancelled by the owner on 2026-11-15. The plan was discarded before implementation.
- No integration, reduced verification feature or follow-up investigation is scheduled. Revisit only if the owner explicitly requests it.
