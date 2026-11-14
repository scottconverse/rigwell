# Your other machines

Rigwell uses your installed SSH client to reach a machine you own. Save a host with
`rigwell machine add <name> <user@host>`, or add it in Settings > Machines. Optional absolute key-file and
known-hosts paths and an SSH port can be supplied. Rigwell uses your SSH agent or selected key file, checks the
host key strictly and runs noninteractively. Add and verify the host in your normal SSH setup first.

Run `rigwell machine bootstrap <name>` to copy a matching build and pinned runtime, verify their file hashes and
start its daemon. The source bundle contains runtime code and dependencies. It does not copy local settings,
provider logins or credentials. Configure model profiles and sign-ins on the other machine. The remote daemon
uses a local socket, with WebSocket, automation webhook and background schedulers disabled for this bootstrap.
The local application reaches that socket through SSH stdio. No inbound daemon port is opened remotely.

Concurrent bootstraps serialize startup through an owner-only SQLite transaction. A process exit releases its OS
lock, including an abrupt Windows exit. A waiting bootstrap rechecks the daemon's build identity before starting
anything. It never removes a guessed stale PID lock or terminates an unrelated process.

Choose the saved machine when creating a session, automation, mission worker or Workstream member. The desktop
shows the machine on session entries and in the session view. The working directory refers to the selected
machine. Files and Terminal operations follow that session's connection. Terminal output on Windows uses pipe
mode, so interactive fullscreen terminal applications and terminal resizing have the existing Windows limits.
Remote session lists and forks retain their machine routing; transcripts remain on their owner.

Automation schedules and run records remain local; the job runs on the selected machine with durable remote notes.
Mission orchestration remains local. A worker receives bounded approved plan files, runs against the remote
repository and reports through the local completion tool. Its commit is verified remotely. Mission library changes
return before handoff and when a turn settles, with namespace, size, link and conflict checks. Conflicting local
edits are retained and reported, while the remote copy remains available. A paused worker resumes on its original
host and working directory even if the defaults change.

Workstreams retain local approval, roster, budgets, messages and listener ownership. A remote member owns a normal
session on its selected host. Permission prompts still go to the actual user. Shared notes use the local
Workstream's guarded file service. Live views and remote file listeners follow the owned member connection.
Archive cleanup retains dirty, pinned, reserved, live, unpushed or open-PR worktrees.

The browser pane can reach a remote loopback port through an SSH tunnel. The optional Remote desktop pane connects
to a VNC server you run on that machine, also through SSH. It does not install or start a VNC server. The viewer
starts in view-only mode; explicitly enable input when needed. VNC passwords remain in memory. Closing a pane or
its session releases its owned tunnel and viewer connections. These tunnels use SSH direct channels to remote
loopback, with configured SSH forwarding disabled.

Acceptance uses fake SSH services, a real copied build and daemon, local bare repositories, fake providers and a
fake RFB service. Windows headless checks cover selected-machine Files and Terminal I/O, durable remote automation,
mission handoffs/library transfer, persistent remote members, messages and listeners, browser tunnelling and the
viewer. This does not establish a real host's SSH/keychain configuration, real remote screen interaction or a
signed release installation.
