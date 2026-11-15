# Separate local profiles

Settings > Local profiles lists the active profile and lets you create profiles and edit their names and descriptive role labels. Role is not an authorization setting. New profiles start with empty Rigwell settings and stored credentials; nothing is copied from Default.

**Switch** opens a confirmation explaining that Rigwell will restart and current agent/background work will stop. Cancel changes nothing. **Restart and switch** relaunches the app with the selected profile. Saved sessions stay in their original profile, and interrupted work is not automatically restarted. The running process never changes its data home underneath an existing engine, prompt, credential refresh or index connection.

The CLI supports the same profiles:

```powershell
rigwell profile create work "Work"
rigwell profile edit work "Work" "Editor"
rigwell profile list
rigwell --profile work exec --cwd C:\Code\example "Describe this repository"
rigwell --profile work auth status
rigwell --profile default profile list
```

`--profile` is a reserved global option and can also appear after the command, before an argument delimiter `--`. Select an existing profile; create it first if absent. IDs use 1 to 48 lowercase letters, digits and hyphens, starting with a letter. Names and role labels are bounded to 100 characters. Duplicate directories, malformed metadata, links and traversal IDs are refused. Metadata is data only, never executable configuration. No profile deletion or credential copying happens during a switch.

The existing `$RIGWELL_HOME`, or the ordinary `~/.rigwell`, remains Default without a migration or rename. Named profiles live under that base at `profiles/<id>/`. Each has its own settings, credential fallback file, session files and SQLite index, daemon socket/advertisement, browser profile, automations and other data rooted in Rigwell home. The app keeps the original Default Electron data location when switching back, including installations that supplied an explicit custom home. Development relaunch arguments retain the Electron app path before custom profile options.

The app and CLI propagate the selected effective home and base identity to their children. Internal environment fields `RIGWELL_PROFILE_ROOT` and `RIGWELL_PROFILE` accompany `RIGWELL_HOME`; do not change them inside a running daemon. The app additionally carries its original Default Electron location during relaunch. Selection is explicit per launch and does not rewrite a machine-wide default or another installation.

Named profiles use distinct OS keychain account namespaces derived from their canonical effective home. Default retains the existing legacy account names. File credentials live in the selected home. Credential lookup caches include home identity, so a cached Default secret cannot satisfy a named-profile lookup. OAuth token references use that same credential store. The base home's `policy.json`, selected profile policy, system policy and explicitly configured legacy managed settings remain effective; creating a profile cannot loosen the base restrictions.

Profiles organize local app data. They are not separate Windows/macOS/Linux accounts or sandboxes. Repository files, environment variables, global instructions and tools can still be shared. Official subscription clients retain the operating-system user's own sign-in/configuration; Rigwell does not copy their tokens, alter their account or pretend that each app profile has a separate subscription. Remote hosts retain their own data and policy. Intentional sync/share/import remain explicit existing operations.

Acceptance uses temporary homes, real CLI processes and fake providers to prove separate credential headers, settings and session search indexes in the same working folder. Fake keychain commands verify namespaces without touching a real keychain. The production headless settings page uses the actual profile controller for create/edit/cancel/confirmed restart arguments, while the restart callback is captured to avoid visible apps. Native installed restart/cookie, real keychain and cross-machine behavior remain separate hardware acceptance.
