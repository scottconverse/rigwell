# Sync between your machines

Sync is off until configured. Open Sync in the sidebar or palette. Choose a private Git remote or a folder,
select the item types and individual display settings, then Save sync configuration. Git privacy is the user's
explicit confirmation; Rigwell does not infer privacy from a repository URL. Git uses the existing OS credential
helper or SSH identity with strict host checking. Credentials are never embedded in the remote URL or copied.

Sync now publishes the selected local data and pulls read-only copies. It does not start an imported automation,
mission, Workstream or session. View a copy before choosing Restore. Restore keeps backups under
`<Rigwell home>/sync/backups`, transfers the item's owner and leaves jobs paused. Automation identity is preserved
but a queued retry is removed. Workstream listeners are cleared and members are interrupted. Sessions require
this machine's working folder and resume with autonomy off. Project trust checks still apply.

Synced data comprises session transcripts/settings and a portable logical index, automation definitions/memory/
identity, mission and Workstream metadata, and the display settings you select. Each machine rebuilds its own
SQLite search index. Credential stores, named secrets, environment files, native-client logins, host identity,
repositories, worktrees, locks and caches are excluded by an explicit file allowlist. Content uses the same
configured-value and credential-pattern redaction as session sharing. Arbitrary unlabeled private information
still requires your review. Repository history or previously replicated packets can retain earlier data.

The Git transport uses only `refs/heads/rigwell-sync-v1`, verifies compare-and-swap pushes and never checks out
remote code or runs repository hooks. Concurrent revisions keep both copies. Restore can select either revision;
existing local files are backed up before replacement. Settings restore merges only selected allowed keys and
keeps local credentials intact. Sync is explicit through Sync now or the CLI, rather than an automatic scheduler.
Sync on the source machine before closing its session and restoring on the destination.

For a shared folder, every machine must reach the same authoritative filesystem with SQLite file-lock support.
Confirm this in the form. An OS-held coordinator lock is released if the process dies. A Syncthing/cloud-drive
replica is different: tick the asynchronously replicated folder option and provide a separate shared-folder or
private-Git lease authority reachable by every machine. Replicated data travels in immutable revision packets;
offline concurrent packets retain both copies when replication catches up. The replica itself never arbitrates
session ownership. Packets are retained, bounded to 64 MiB in total, and are not automatically pruned.

A loaded engine claims its session before hooks, MCP startup, compaction or its first model turn. It keeps the
lease while idle because its transcript remains in memory. Leases expire after 60 seconds and renew every 15
seconds through the authority. A second engine is refused before hooks or model calls. Failed renewal or expiry
interrupts the turn and background work and requires closing/reloading the engine. Closing releases the lease;
an unexpired lease prevents restoring its transcript or changing/disabling sync. Never configure different lease
authorities for machines that continue the same sessions. Offline data viewing works; offline continuation of a
synced session fails closed when its authority cannot be reached.

CLI configuration accepts a JSON file containing explicit selections. For example:

```json
{
  "version": 1,
  "target": { "kind": "git", "remote": "git@example.test:private/session-sync.git", "private": true },
  "kinds": ["session", "automation", "mission", "workstream", "settings"],
  "settings": ["diffMode", "showThinkingInMainView"]
}
```

For one shared folder use `target: {"kind":"folder","path":"<absolute folder>"}` and
`folderIsAuthority: true`. For a replicated folder add `replicated: true` to the folder target and a separate
`leaseTarget` object. Do not put targets inside the runtime home or route them through user-controlled links.

```
rigwell sync configure sync.json
rigwell sync status
rigwell sync now
rigwell sync view session/<session-id>
rigwell sync restore session/<session-id> --cwd <working-folder>
rigwell sync restore workstream/<id> --hash <conflicting-copy-hash>
rigwell sync off
```

Local acceptance uses fake engines, local bare Git repositories and copied folder packets. The desktop flow is
tested headlessly through real daemon RPC. No real Git hosting, cloud-drive service, credentials or model call
is used by automated checks. Real shared-filesystem and cloud-drive deployments remain hardware acceptance.
