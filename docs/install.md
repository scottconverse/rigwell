# Install Rigwell

Rigwell runs locally. Its desktop packages include the daemon and Bun runtime;
users do not need a separate Node or Bun installation to open the packaged app.
Git and ripgrep are needed for coding work. Provider access is configured after
installation; opening Rigwell does not require a model credential.

Use artifacts from the exact candidate recorded in the release notes. Do not
mix an installer, update metadata or signatures from different builds. Verify
the published checksum before installing and keep the previous installer and
a backup of your Rigwell profile when upgrading.

## Windows

Current release: [signed Windows 0.4.1 installer](https://github.com/scottconverse/rigwell/releases/download/v0.4.1/rigwell-setup-0.4.1-x64.exe). See [0.4.1 release notes](release-0.4.1.md). Linux and macOS downloads remain at [0.4.0](https://github.com/scottconverse/rigwell/releases/tag/v0.4.0).

Run `rigwell-setup-<version>-x64.exe`. The NSIS installer installs for the current
user and lets you choose its destination. Verify the installer signature in
Properties > Digital Signatures: the publisher must be Scott Converse. The
release receipt records the expected SHA-256 and timestamp. A missing or invalid
signature is not a signed release.

Open Rigwell from its shortcut. On first run, the home page offers account
sign-in and configuration of an API or local model. Existing official-client
subscription profiles use those clients' own sign-in and refresh; Rigwell
continues to coordinate its sessions and Workstreams. Rigwell also supports
direct provider adapters. AWS access is optional and requires the user's own
account; no AWS live acceptance is claimed for this build.

Uninstall with Windows Installed Apps. Back up profile data before removal.
Reinstalling an older binary is a manual rollback and does not reverse profile
data migrations.

## macOS

Open the matching architecture's DMG and copy Rigwell.app to Applications.
Open the app to configure account or local-model access. Keep the DMG until
the upgrade has been checked.

Current candidate artifacts are unsigned and not notarized because the owner
does not have a Developer ID certificate. They are development artifacts;
the project does not claim Gatekeeper acceptance of a downloaded release.
Clean CI installation and first-run checks do not establish real Mac keychain,
notification, tray, clipboard or deep-link behavior. That hardware check awaits
an available Mac.

## Linux

Install the Debian package with your package manager:

```sh
sudo apt install ./rigwell-<version>-<arch>.deb
```

Alternatively, make the AppImage executable and run it from a directory you
own. AppImage operation may require your distribution's FUSE compatibility
package. The signed update tarball contains one `Rigwell.AppImage` and is
verified against the embedded release public key before replacing an existing
AppImage. It is not an arbitrary source archive.

File > Restore previous Linux version restores the locally retained previous
AppImage after confirmation. For Debian installations, reinstall the previous
package with the package manager. Profile data is separate from binary rollback.
See [release updates](release-updates.md) for signature and rollback behavior.

## First run and profiles

The default agent profile is `~/.rigwell`. Desktop appearance and update
preferences are stored separately from agent settings inside that profile.
Named local profiles use isolated settings, sessions and credential namespaces.
Selecting a model or enabling a connector remains explicit. Do not paste
credentials into a chat transcript or commit them to a repository.

## Candidate acceptance

The platform workflows build installers from the candidate checkout. Installed
acceptance installs NSIS on a clean Windows runner, mounts and copies the DMG
on macOS, and installs the Debian package on Linux. It starts the installed app
with an empty isolated profile, verifies the bundled runtime process and local
daemon, and checks the first-run model setup page. No model is called and no
personal settings or credentials are imported. Packages and JSON receipts are
retained as workflow artifacts for seven days.

### Windows 0.4.1 patch

The Windows installer is built from runtime source `2267038`, including fixes
`6a63f66`. Azure sign-only run `43945597302` returned final bytes with SHA-256
`bcfb08613452b53092a4498d9de7d7161fb3338cf3e6468c070b409d97f39be2`
and length 153,492,432 bytes. Halo independently verified the valid Scott
Converse publisher, Microsoft timestamp and receipt hashes before silently
upgrading from 0.4.0. All 64 agent data files and 59 desktop-profile files
matched the pre-install backups. Credential readback passed without writes.
Installed payload hashes matched the build. Five installed-daemon/desktop
controller checks passed, including proposal reattachment; a live native
approval executed an independently checked marker command. The installed CLI
listed all 43 evaluation tasks. No interactive app window was used on Halo.
Only the setup installer is signed; the inner app and uninstaller are not
individually signed. No new signed updater-dialog or rollback trial is claimed.

Final pre-publication commit `ce6d3cd` passed Linux core/desktop run
`43946800706`, Windows/macOS tests, packaging and clean-runner installation
`43946800709`, and website build/deploy `43946801429`. The exact signed runtime
is unchanged by subsequent release-documentation updates.

### Retained 0.4.0 cross-platform evidence

The 0.4.0 packages are built from source `28cac5b`. Runs `43742095558`
and `43742095548` passed all four required Linux, macOS and Windows jobs,
including real installed first run and all 43 bundled evaluation tasks. The
Windows installer registers its URL handler before first launch; an actual
Windows-shell deep link reached Workstreams. Linux release run `43742725196`
passed packaged installation, upgrade and rollback.

The retained 0.4.0 signed Windows setup installer has SHA-256
`19d3a80b6e46065cb612d9ba69d0ab15a8cf23699a541d2130c31e9a78a6730c`.
Signing run `43743441653` passed; its returned bytes, signing receipt,
Scott Converse publisher and Microsoft timestamp were independently verified
on Windows. The application executable and uninstaller are not individually
signed in this branch's packaging path. Signed release acceptance run `43743716936` passed actual baseline installation,
0.4.0 upgrade, registered deep-link delivery and explicit local rollback.
Remote downgrade was refused. Native updater-dialog interaction is not claimed.

The published release includes final-byte checksums and acceptance metadata.
Documentation-only successors do not change these packaged inputs. These
runner results do not establish a real Mac hardware pass. Do not label a
temporary profile on Halo a clean machine.
