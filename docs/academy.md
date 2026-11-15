# Offline Academy

Open **Help > Academy tutorials** in the desktop, or run `rigwell learn`. Nine bundled tutorials cover getting started, models and keys, skills, hooks, MCP, worktrees, missions, Workstreams and automations. Tutorial content is shipped with the app and requires no account or network request. Account configuration, subscription sign-in and real model execution remain in their existing Settings and Session flows.

Select a lesson and **Start new practice** to create a private temporary Git repository. Its displayed file has a starter exercise; edit it, then **Save practice** or **Check practice**. A valid example is available for learning the format. Checks inspect the actual saved sample file using existing configuration parsers where applicable. They report precisely what passed and what was not run. They do not contact a model endpoint, execute lesson instructions/hooks, start MCP, launch a mission/Workstream or register an automation. The models exercise accepts only key-free loopback configuration and refuses credential fields before credential lookup.

The worktrees lesson additionally creates a real `academy-practice` branch and separate worktree inside the sample directory. The check inspects Git's actual worktree registration and branch identity. No remote is configured and nothing is pushed. Sample Git operations remove inherited Git routing variables, isolate global/system config and disable hooks, signing, fsmonitor and interactive prompts. This prevents a parent's GIT_DIR from redirecting work into another repository. Linked Git metadata is refused.

Practice roots have random ids under the canonical OS temporary directory and an ownership marker. Operations resolve only known lesson files within a validated root, reject path escapes, links/junctions, invalid ids and corrupt ownership, and bound practice text at 64 KiB. They do not change ordinary Rigwell settings or other projects. Saved progress can be resumed while the OS retains that temporary folder. The OS may clean it; preserve useful edits elsewhere rather than treating it as permanent storage.

**Open sample session** opens the usual New Session screen with that sample folder. It does not send a prompt or select a different provider. Any real work uses the configured profile and normal permissions. Save your practice text first. Close sessions using a sample before removing it. **Remove sample** requires confirmation and deletes that owned sample, its sample worktree and all edits inside it; other practice repositories remain intact.

```text
rigwell learn list
rigwell learn workstreams
rigwell learn practice skills
rigwell learn practices
rigwell learn read <practice-id>
rigwell learn save <practice-id>
rigwell learn check <practice-id>
rigwell learn worktree <worktrees-practice-id>
rigwell learn remove <practice-id> --yes
```

`save` reads the complete file content from stdin. `check` returns JSON and exits 1 for an incomplete exercise, 0 for a passed format/state check. Other errors exit 2. On Windows, this command uses a synchronous stdin read because the installed Bun version can exit while an asynchronous stdin promise is still pending. `remove` requires `--yes`; there is no automatic cleanup of saved practice on closing the tutorial.

Tests use temporary repositories, fake services and the headless production component connected to the actual daemon. They cover all nine valid/incomplete exercises, persistence, unchanged account settings, a real sample worktree, hostile inherited Git routing, link/ownership refusal, CLI piping and confirmed selective cleanup. The native Help-menu check runs in platform CI. No live model practice or installed-desktop acceptance is inferred from these checks.
