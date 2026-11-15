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

These checks are prepared; their successful execution must be recorded in the
handoff before treating installed acceptance as complete. They do not establish
signed public delivery, a real Mac hardware pass or a successful packaged
upgrade/rollback. Do not label a temporary profile on Halo a clean machine.
