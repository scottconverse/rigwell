# Next-version list

This is the tracked list of owner-requested work for the version after the shipped 0.4 release series, including Windows maintenance patches. The next version number is not assigned. These items do not change current release scope or acceptance. Record future requests here rather than adding them to the current release checklist.

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

## NV-004: Workstream member write boundaries

- Requested by the owner on 2026-11-18. Included in the Windows 0.4.4 candidate for local direct-model members with approved structured assignments.
- Observed in the headless live Dispatch Lab run on installed Windows 0.4.3. Verifier's assigned project file was `test/acceptance.test.js`. Before integration approval, Verifier created a temporary harness outside its assigned files that referred to code from multiple worktrees. Its own Git worktree still showed only the assigned file, so checking the worktree diff alone missed the external writes.
- The daemon denies and records writes outside assigned files. Members can review peer worktrees and ask the lead to perform operations beyond their assignment. The scoped path uses direct file tools; signed-in native clients can coordinate as lead.
- The daemon regression verified denied writes and their records. The headless live Dispatch Lab completed review and approved integration with all three members staying within their assigned files. Evidence is recorded in the [Rigwell handoff](handoff/HANDOFF.md#state).

## NV-005: Dispatch Lab partial-write recovery

- Requested by the owner on 2026-11-19. Status: tracked for the next version. Implementation is deferred.
- The final review on installed Windows 0.4.4 identified an untested case in the Dispatch Lab CLI. If the plan write succeeds and the filesystem rejects the summary write, the two outputs may be left in different states. The live run verified existing-output preservation for malformed and invalid input. It did not simulate failure during the writes.
- Reproduce a write failure after the plan write and before the summary finishes. Define and verify a recoverable outcome for both destinations with a deterministic fault-injection check. Keep coverage for normal writes and invalid-input preservation. See the [live 0.4.4 result and evidence locations](handoff/HANDOFF.md#state).
