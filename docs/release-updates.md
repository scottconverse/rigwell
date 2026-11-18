# Release updates

The default feed is the `latest/download` folder of GitHub Releases in
`scottconverse/rigwell`. Settings > General or `RIGWELL_UPDATE_URL` can select
another feed. An explicitly empty saved URL disables checking. Development
builds do not automatically contact the public feed.

Generate metadata only after signing, using the final uploaded bytes:

```powershell
bun desktop/packaging/prepare-feed.ts win32 0.4.3 C:/release/rigwell-setup-0.4.3-x64.exe
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
& desktop/node_modules/app-builder-bin/win/x64/app-builder.exe blockmap --input=C:/release/rigwell-setup-0.4.3-x64.exe --output=C:/release/rigwell-setup-0.4.3-x64.exe.blockmap
```

The Linux tarball contains exactly one regular `Rigwell.AppImage`. Prepare,
sign and describe the archive in that order:

```powershell
bun desktop/packaging/linux-release.ts /release/rigwell-0.1.0-x64.AppImage /release/rigwell-0.1.0-x64.tar.gz
bun desktop/packaging/sign-update.ts sign /private/update-private.pem /release/rigwell-0.1.0-x64.tar.gz
bun desktop/packaging/prepare-feed.ts linux 0.1.0 /release/rigwell-0.1.0-x64.tar.gz
```

Official builds embed the public half of the release key. The private half is
held outside the checkout under the release owner's local application data,
with a directory ACL restricted to that owner and SYSTEM on Windows. Back up
that key securely; do not add it to Git or upload it with release artifacts.
Custom distributions can select their own key in settings or the environment.
The verified archive is parsed without filesystem extraction: only the expected
regular payload is accepted, with checked lengths, header checksum and zero
trailing blocks. Links, traversal names, extra entries and truncated archives
are refused before any installed file is changed.

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

## Current published platform versions

Windows uses 0.4.3. Its `latest.yml` and blockmap are generated from the final
signed installer, not the unsigned packaging output. The release includes
SHA256SUMS.txt, the signing receipt and release-acceptance.json. See
[0.4.3 release notes](release-0.4.3.md) for exact source and installed evidence.
Linux and macOS remain at 0.4.0. The latest release carries their 0.4.0 feed
metadata with absolute links to the existing immutable 0.4.0 assets; versions,
hashes, lengths and Linux signatures remain unchanged. A 0.4.0 installation on
those platforms stays current, and earlier installations can still find 0.4.0.
A Windows-only patch does not relabel or rebuild the other platforms.

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

The embedded Linux public key and strict tarball install path are implemented;
independent system tar listing/extraction and fake signed-feed upgrade/rollback
checks pass. Clean-runner installed first run passed for all three platforms on
`5fc5687` (runs `43692783551` and `43692783541`), and on corrected runtime
`59dc19d` with all 43 bundled tasks discovered. Real Linux packaged update and
rollback passed on `59dc19d` and again in explicit dispatch `43732261845` on
workflow successor `3787b24`. The receipt distinguishes loopback package
verification from native update-dialog interaction.
The owner has no macOS Developer ID certificate; notarization is not claimed.

For signed Windows package acceptance, dispatch the existing platform workflow
on the working branch with `signed_baseline_run` and `signed_candidate_run`
identifying the retained completed sign-only runs. The isolated Windows runner downloads the preserved signed
baseline and candidate, verifies their receipts and native signatures, then
checks installation, signed loopback upgrade, version readback, refusal of a
remote downgrade and explicit local installer rollback. Its receipt states
that native updater-dialog interaction is not exercised. No signing private
key or personal access token is added to the Rigwell workflow. Corrected signed
runtime `59dc19d` passed this path in run `43731720393`, using signing runs
`43689064653` and `43730993976` for the baseline and candidate respectively.

Linux package upgrade acceptance runs through an explicit dispatch of `ci.yml`
with `baseline_run` naming a retained CI run containing the 0.1.0 package.
Ordinary pushes still check current installers and installed task discovery,
without depending on a historical artifact that will expire. Select available
baseline runs when performing a release check; workflow artifact retention is
not permanent release storage. Do not silently substitute a different baseline
or treat an unavailable artifact as a passing check.
