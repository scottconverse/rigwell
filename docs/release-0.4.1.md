# Rigwell 0.4.1: Windows approval and Workstream recovery fixes

Historical Windows release: **0.4.1**. See [0.4.4](release-0.4.4.md) for the current Windows patch. Linux and macOS distributions remain at
**0.4.0**. This maintenance patch preserves the existing UI, local Session
loop, Missions, Workstreams and configured model connections.

## Download and upgrade

- [Signed Windows x64 installer](https://github.com/scottconverse/rigwell/releases/download/v0.4.1/rigwell-setup-0.4.1-x64.exe)
- [Release assets, checksums and receipts](https://github.com/scottconverse/rigwell/releases/tag/v0.4.1)
- [Linux/macOS 0.4.0 downloads](https://github.com/scottconverse/rigwell/releases/tag/v0.4.0)
- [Installation and recovery](install.md) and [full user manual](user-manual.md)

Pause running work and retain a profile backup and the previous signed
installer. Run the new installer over the existing installation. Settings,
sessions and credential references remain in their existing stores. Rigwell
does not import or copy the subscription clients' OAuth tokens. The default
Windows update feed offers 0.4.1 to earlier versions. Linux/macOS feed documents
continue to reference the unchanged 0.4.0 assets.

## Fixed behavior

1. **Native command approvals reach Rigwell.** Unresolved Claude native tool
   permissions use the client's permission callback on Rigwell's authenticated
   request-scoped bridge. The panel identifies the tool, workspace and requested
   operation. Allow once or cancel; no global permission grant is made. Missing
   approvers, interruption and read-only transitions fail closed. Native deny
   rules still apply. See [authentication and permissions](auth.md).
2. **Pending Workstream proposals survive a view reconnect.** The owning
   Session registers the service approval and restores it when that view
   reconnects while the Session remains alive. Resolved or cancelled requests
   cannot be approved late to create a Workstream. Daemon-restart recovery is
   separate from restoring a live pending prompt. See [Workstreams](user-manual.md#workstreams).
3. **Native coordination context is retained across invocations.** Subsequent
   requests include the owning native call/result receipts so member IDs,
   messages and listener results stay available to the coordinator. Direct
   adapters retain their existing history behavior.

The original reported proposal cancellation's exact external trigger was not
established. The missing pending-prompt recovery was reproduced and fixed.

## Existing features retained

### Post-release finding

A later interactive Windows Workstream exercise reproduced missing message
bodies in subscription-client model context after **Next** listener delivery.
Members requested repeated handoffs and reached the configured token budget.
**Now** delivery recovered the observed message bodies, but the exercise was
paused before integration and final acceptance. This does not invalidate the
historical passing exercise below, and it does establish an unresolved defect
in the released binary. See [Workstream recovery](workstreams.md#known-041-message-delivery-issue).
The published tag, installer and signing evidence remain unchanged.

The [manual's reference library](user-manual.md#reference-library) covers the
current functions: desktop sessions, files/terminal/browser/side chat, direct
and subscription execution, local endpoints, persistent Workstreams, Missions,
Git worktrees and PRs, review, automations and triggers, delegation and Inbox,
connectors/MCP OAuth, plugins, wiki, Academy, Analytics, Evaluations, profiles,
policy, budgets, fallback models, machines, sync/sharing, phone access,
notifications, Labs and crash diagnostics. These require configuration where
documented; publication does not establish live acceptance for every external
service or account. Hosted Stax remains next-version work. No cancelled
DevHarmonics integration is included.

## Provenance and acceptance

- Runtime source: `2267038c06a168afcdf44069138303f15e3a784a`, including fixes
  `6a63f66`. Release documentation is newer; the signed runtime is unchanged.
- Signed installer: 153,492,432 bytes. SHA-256:
  `bcfb08613452b53092a4498d9de7d7161fb3338cf3e6468c070b409d97f39be2`.
- Azure sign-only run `43945597302` in `scottconverse/civiccast`. Independently
  verified Scott Converse Authenticode signature and Microsoft timestamp.
  Only the setup installer is signed; the inner app and uninstaller are not
  individually signed. The public receipt retains its original intake filename.
- Halo silent upgrade: exit 0, version 0.4.1; all 64 agent-data files and 59
  desktop-profile files matched pre-install backups. Saved credential readback
  passed without credential writes. All 315 installed daemon sources and the
  desktop bundle matched the build.
- Installed runtime: five trust/question/permission/proposal-reconnect checks
  passed with 18 assertions; all 43 evaluation tasks discovered. A live native
  command requested one Rigwell approval and created an independently checked
  execution marker.
- Real three-member Workstream exercise before packaging: contract handoffs,
  review, integration and final verifier; agent tests 41/41 and independent
  grader 16/16, including 100 randomized schedules. Headless Workstreams roster
  and transcript checks passed. Personal transcripts and settings are private.
- Pre-publication verification commit `ce6d3cd`: Linux core/desktop CI
  `43946800706`, Windows/macOS tests, packages and clean-runner installation
  `43946800709`, and website build/deploy `43946801429` passed. Subsequent
  documentation commit checks are linked on the GitHub release.

Halo acceptance was headless. Interactive updater-dialog acceptance and a new
0.4.1 rollback trial are not claimed. Prior signed 0.4.0 upgrade/rollback
receipts are retained. Full model-family and long-session qualification remains
incomplete; account entitlement and service configuration are user-specific.
Real Mac hardware acceptance is unavailable; 0.4.0 macOS assets are unsigned.
