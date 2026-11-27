# Native platform acceptance

## Windows Halo, November 14, 2026

The owner approved interactive testing for this run. The app used a disposable home, temporary Git repository and fake model service. Personal model settings and existing credential entries were not used.

- Full local desktop suite: 224 passed, five Linux-package skips, zero failures, 1260 assertions. Includes actual Electron trust/questions, tray visibility and attention, and a live terminal surviving reload. This suite ran after the temporary-profile fix and before final credential integration checks.
- Actual Windows Credential Manager: a uniquely named synthetic entry was absent, created, read back with Unicode, replaced, deleted and confirmed absent. No secret value was printed. Native backend operations require no interactive dialog or elevation.
- Actual Electron app: Help's copy command placed the expected text in the OS clipboard. The private probe saved advertised format buffers in memory and attempted to restore them in finally; exact multi-format restoration was not independently checked. No clipboard content was retained in the receipt.
- Native tray creation and attention state were read from the running app. An OS notification reported supported and emitted its native show event. That verifies submission, not visual appearance under every Windows notification/focus setting.
- The running app's OS URL event handler routed a rigwell URL to Workstreams. This does not establish installed protocol registration or a browser-to-installed-app round trip.
- All owned probe/test apps and daemons exited. No live model or subscription calls occurred.

Private receipts outside Git: ../windows-desktop-after.log, ../windows-native-handlers.log, ../windows-keychain-probe.log and ../hardware-native-result.json. The latter used the notification candidate plus credential/test-setup source changes. Fake-runner credential/rotation tests separately cover final integration.

The initial native suite failed before app startup because the isolated USERPROFILE lacked AppData/Roaming and Local. A minimal native Electron probe reproduced failed known-folder lookup, then succeeded with those directories present. Test preload now creates them, retaining personal-home isolation. No app path fallback or test deadline was changed.

## Credential behavior

Windows now tries current-user generic Credential Manager entries before the existing owner-private file fallback. Names are prefixed with rigwell and named profiles retain their hashed namespace. A fixed PowerShell/C# bridge calls the documented CredReadW, CredWriteW and CredDeleteW APIs. Names and values travel over stdin, never interpolated into code or command arguments; the subprocess is hidden and bounded. Unicode values use UTF-8. Windows' 2560-byte credential blob limit, unavailable PowerShell or native refusal fall back to the existing file store.

Successful credential rotation removes the same name from other available backends so an older native value cannot shadow a new file fallback. A failure to remove a readable stale value is reported as an error. Existing credential files are not automatically migrated. Ordinary tests use isolated files; backend tests inject fake runners, and native acceptance is an explicit hand run.

API reference: [CREDENTIALW](https://learn.microsoft.com/en-us/windows/win32/api/wincred/ns-wincred-credentialw), [CredWriteW](https://learn.microsoft.com/en-us/windows/win32/api/wincred/nf-wincred-credwritew).

## Remaining release acceptance

Real macOS hardware is unavailable; the owner requested continued work without it. macOS CI tests and unsigned packaging are verified separately. Real macOS Keychain, clipboard, terminal, notifications, tray and deep links remain pending. The completed Windows release checks are recorded below; this historical native probe alone does not establish those outcomes.

Release follow-up: signed Windows installation, version upgrade and rollback passed in run 43731720393 on corrected runtime 59dc19d; empty-profile installed checks and all 43 bundled tasks passed. Decision 505 adds a runner-only check for registry registration before first launch and actual Windows-shell URL delivery. The corrected installer registration and actual Windows-shell Workstreams route passed in run `43742095548`; signed update, routing and rollback passed in `43743716936`. This supplements the earlier native event-handler probe without taking over Halo.

Previous Windows patch: [0.4.1](release-0.4.1.md) passed a settings-preserving signed Halo upgrade, installed approval/proposal-reconnect checks and clean-runner installation. Its installed verification was headless. The broader 0.4.0 native probe and signed rollback evidence above remain historical evidence, rather than a new interactive 0.4.1 trial.

The [Windows 0.5.2 release notes](release-0.5.2.md) record the current package. The [0.4.5 release notes](release-0.4.5.md) record the desktop interface and Mission worker changes. The [0.4.4 release notes](release-0.4.4.md) record the headless Workstream acceptance.
