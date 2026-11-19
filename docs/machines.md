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

For a Windows target, the local OpenSSH client also needs `scp` with SFTP support and the destination needs its
SFTP subsystem enabled. Rigwell verifies the uploaded archive before extracting it. Windows starts the daemon
under the SSH user's account so the daemon stays available after the bootstrap connection closes.

Concurrent bootstraps serialize startup through an owner-only SQLite transaction. A process exit releases its OS
lock, including an abrupt Windows exit. A waiting bootstrap rechecks the daemon's build identity before starting
anything. It never removes a guessed stale PID lock or terminates an unrelated process.

## Fleet management

Open Machines in the desktop sidebar or run `rigwell machine list`. Both use the same controller and report each
saved SSH machine's online state, OS, version, running session count, load and last successful contact. Refresh
checks the saved build through its verified SSH channel. Offline counts/load remain unknown and the previous
last-seen time is retained. Load includes memory usage and CPU count; Unix hosts also report the OS load average.
Windows CPU load average is unavailable rather than reported as zero.

- `rigwell machine stop <name>` interrupts the daemon's session engines, including tasks, automations and member
  sessions, clears their pending messages and cancels background jobs. Mission and Workstream owners are paused.
  Transcripts and worktrees remain. A later user turn is allowed; future scheduled automation occurrences retain
  their existing schedules.
- `rigwell machine restart <name>` requests graceful shutdown of the verified saved build, waits for its channel
  to close and starts that same immutable build. Running work is refused; stop it explicitly first.
- `rigwell machine update <name>` shuts down an idle verified old daemon and installs this local Rigwell build.
  If installation fails before recording a replacement, it attempts to restart the previous build. Inspect any
  reported recovery failure before continuing. `rigwell machine update-all` reports each machine separately and
  continues after a failed host; its exit code is nonzero if any update failed.
- `rigwell machine remove <name>` forgets the saved connection. It preserves remote files, credentials and daemon.

The Machines page provides these same actions, confirms them before execution, displays individual bulk failures
and also lets you add a connection. Restart/update require a reachable daemon with the management protocol; a
host-key, authentication or protocol error is reported without killing a guessed remote process. `bootstrap`
remains the initial installation command. Fleet status covers saved SSH machines, not an unrelated local updater.

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

Headless fixture checks cover selected-machine Files and Terminal I/O, durable remote automation, mission
handoffs and library transfer, persistent remote members, messages and listeners, browser tunnelling and the
viewer. A separate run bootstrapped the source candidate over real SSH to a Windows host and verified that a
session reloaded with its original transcript and Git worktree. That run used a deterministic model fixture.
