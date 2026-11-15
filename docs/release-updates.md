# Release updates

The default feed is the `latest/download` folder of GitHub Releases in
`scottconverse/rigwell`. Settings > General or `RIGWELL_UPDATE_URL` can select
another feed. An explicitly empty saved URL disables checking. Development
builds do not automatically contact the public feed.

Generate metadata only after signing, using the final uploaded bytes:

```powershell
bun desktop/packaging/prepare-feed.ts win32 0.1.0 C:/release/rigwell-setup-0.1.0-x64.exe
bun desktop/packaging/prepare-feed.ts darwin 0.1.0 /release/rigwell-0.1.0-arm64.zip /release/rigwell-0.1.0-arm64.dmg
bun desktop/packaging/prepare-feed.ts linux 0.1.0 /release/rigwell-0.1.0-x64.AppImage
```

This writes `latest.yml`, `latest-mac.yml` or `latest-linux.yml` beside the
artifacts without uploading anything. Windows needs one installer; macOS needs
a ZIP, with an optional DMG. Linux needs a base64 Ed25519 `.sig` file beside
each artifact. Hashes and lengths are recomputed from the final files. Do not
reuse unsigned metadata or blockmaps after signing. Generate a new Windows
blockmap from the final signed installer with the bundled app-builder binary:

```powershell
& desktop/node_modules/app-builder-bin/win/x64/app-builder.exe blockmap --input=C:/release/rigwell-setup-0.1.0-x64.exe --output=C:/release/rigwell-setup-0.1.0-x64.exe.blockmap
```

Publish matching metadata, artifacts and blockmaps together only as an
authorized release. Preparing a local feed does not publish a release.

Windows refuses installation unless the downloaded installer has a valid
Authenticode chain, a timestamp and the exact Scott Converse publisher
distinguished name pinned in `release-config.ts`. A separate check runs before
installation for both fresh and cached downloads. Automatic installation on
quit is disabled so a refused download cannot install later. Failure to run
Windows verification also refuses installation. The verifier uses only the
OS-shipped PowerShell modules, avoiding incompatible module paths inherited
from a PowerShell 7 parent.

On Linux, verified AppImage installation retains the previously installed
file as `.previous`. File > Restore previous Linux version restores those
local bytes after confirmation. A remote feed never offers a lower version.
Back up profile data before upgrading: binary rollback does not reverse data
format changes. Both installation and rollback refuse symbolic links or
nonregular files in their replacement paths.

## Acceptance evidence and limits

The local fake feed test covers discovery, signed download, two successive
fixture installations, local rollback and refusal of a remote downgrade.
Additional cases cover tampering, missing signatures and keys, wrong hashes,
failed downloads and linked replacement paths. Windows fake verifier tests
cover invalid results, missing tools, wrong publishers, missing timestamps
and cached installer refusal. These checks do not replace actual packaged
install/update/rollback acceptance.

The baseline Windows installer from runtime commit `7a66c3a` was signed through
the existing owner-approved Azure sign-only workflow, run `43689064653` in the
repository formerly named `civiccast-native`, now redirected to `civiccast`.
The unsigned input SHA-256 was
`8a0636ab54c1adb471d4e0d11ab933b2179de07fb530dbe8f4c55dbaef7f4b6b`;
the signed output SHA-256 is
`31e35944db4be2b7b4c964a5cb0f85e01004b915e05536e74457765545baf5e6`.
Halo independently verified the receipt, valid signature, expected publisher
and Microsoft timestamp. The new runtime verifier accepts that actual signed
installer and refuses its preserved unsigned original. The intake remains an
unpublished draft. This baseline does not contain subsequent updater changes.

Real packaged update/rollback, embedded Linux release-key configuration,
Linux tarball installation and clean-machine first run remain pending.
The owner has no macOS Developer ID certificate; notarization is not claimed.
