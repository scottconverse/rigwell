# Local policy

Rigwell reads `policy.json` from `$RIGWELL_HOME` and the platform system folder:

| Platform | System file |
| --- | --- |
| Windows | `%ProgramData%\Rigwell\policy.json` |
| macOS | `/Library/Application Support/Rigwell/policy.json` |
| Linux | `/etc/rigwell/policy.json` |

An administrator installs and protects the system folder/file using OS ownership
and permissions. Rigwell reads it and never creates, elevates or rewrites it.
The home file provides controls for the current local user. These are application
controls, not a sandbox against someone who controls the executable, process
environment or their own policy file. System ownership/ACL provisioning belongs to
deployment; the reader does not claim to attest administrator ownership.

Policies are optional. A present file must be an unlinked regular JSON file of at
most 1 MiB, have `schemaVersion: 1`, and contain only the documented keys with
valid types. Malformed or unreadable policy fails the operation; it is not ignored.
Policies are never loaded from a repository. The earlier explicit managed-settings
environment file remains supported, but cannot replace local/system policy.

```json
{
  "schemaVersion": 1,
  "modelPolicy": {
    "allowedModelIds": ["custom:Work-0"],
    "blockedModelIds": [],
    "allowCustomModels": true
  },
  "maxAutonomyLevel": "low",
  "missions": {
    "enabled": true,
    "maxConcurrentRuns": 1,
    "maxFeatures": 30,
    "maxWorkerAttempts": 3
  },
  "workstreams": {
    "enabled": true,
    "maxActive": 2,
    "maxMembers": 4,
    "maxConcurrentAgents": 2,
    "allowNestedSpawn": false
  },
  "mcpServerAllowlist": [],
  "requiredHooks": {
    "PreToolUse": [{
      "matcher": "Execute",
      "hooks": [{"type": "command", "command": "review-command", "timeout": 30}]
    }]
  }
}
```

This example is illustrative; Rigwell does not install it or run that example
command. Choose actual model profile IDs, commands and limits for the machine.
All fields except `schemaVersion` are optional.

## Composition and enforcement

Home and system restrictions compose: allow-lists intersect, block-lists union,
numeric ceilings take the smaller value, and `false` restrictions stay false.
Required hooks from both files run, system groups first. User, project, folder
and runtime settings cannot loosen those controls. Settings sources list the
contributing policy paths and mark managed keys.

- `modelPolicy` uses exact configured IDs or API identifiers. Blocked wins over
  allowed. An empty allowed list permits no model. `allowCustomModels: false`
  retains the existing managed-model semantics: lower-level custom profiles are
  removed, while any explicitly managed profiles remain subject to the ID rules.
  All consumers of `resolveModels`, including the evaluator judge, filter policy.
- `maxAutonomyLevel` is `off`, `low`, `medium` or `high`. Existing Session creation,
  settings updates and permission-option filtering apply the ceiling. Attempts to
  raise the session are clamped to it, not treated as a granted higher level.
- Missions limit simultaneously running missions in the owning service, total
  noncancelled features (including validator features), and worker attempts per
  feature. A user-approved retry bonus cannot exceed `maxWorkerAttempts`. Admission
  is reserved before starting a worker. `enabled: false` prevents new proposals
  and runs; zero concurrent runs prevents execution. Feature/enable limits are
  checked again before subsequent workers. Existing recovery and handoff gates stay.
- Workstreams limit active streams in the owning home store, nonarchived members
  per stream (failed members still count), and simultaneous member turns per
  stream. A turn retains its existing admission slot through tools and user prompts.
  Archived members release member-count capacity. Proposal acceptance, member
  spawn, resume and each next member turn check policy. Zero concurrent agents
  disables execution. `allowNestedSpawn: false` prevents nested member spawning.
  Tightened concurrency is saved into the stream; raising a policy later does not
  silently increase the saved stream setting.

Counts are coordinated by the normal owning daemon/service. This does not add a
cross-process distributed quota authority or remotely install a policy on another
machine. Each remote engine enforces its own machine's policy and the existing
owner-provided member bounds. Install the intended policy on each managed host.

## MCP and required hooks

An absent `mcpServerAllowlist` leaves normal configuration available. An empty
list permits none. Entries pin a name, transport and actual launch descriptor:

```json
{
  "schemaVersion": 1,
  "mcpServerAllowlist": [
    {"name":"local-tools","type":"stdio","command":"/absolute/tool","args":["serve"],"env":{}},
    {"name":"remote-tools","type":"http","url":"https://tools.example.invalid/mcp"}
  ]
}
```

Stdio command, ordered arguments and explicit environment must match exactly;
HTTP/SSE endpoint strings must match exactly. Authentication headers and OAuth
credentials remain in the existing credential flow rather than policy. Normal
inherited process environment still applies. A project cannot replace an allowed
name with a different executable, argument list, explicit environment or endpoint.
Check before startup, reconnect, sign-in, add persistence and live tool calls.
Rejected configured servers show failed status; blocked additions do not write
`mcp.json`. Already-running actions are not retroactively undone.

`requiredHooks` uses the existing event/group/matcher/command format. Unknown
events, invalid regexes and malformed commands refuse policy. These groups cannot
be removed by project hooks, runtime hooks, `hooksDisabled` or managed-hooks-only
mode. Ordinary disabled hooks stay disabled. Both the loop's hook-presence check
and the actual hook runner preserve required groups, with normal hook outcomes
and cancellation. This covers Rigwell hook events and tools; native subscription
clients retain their own internal tools and hook behavior.

Model/autonomy and hook configuration are loaded when a Session is built. Restart
or reopen sessions after editing those fields. Admission limits and MCP calls
reread policy for their next operation; an active request is not killed merely
because a policy file changes.

Acceptance uses temporary policies, fake local providers/workers/MCP servers and
the actual Session/protocol/mission/Workstream paths. It includes an actual
required hook denying a Read before file contents reach the fake provider, even
with ordinary hooks disabled. No real provider traffic or system policy mutation
is part of tests.
