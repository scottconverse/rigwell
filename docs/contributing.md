# Contributing to Rigwell

Start with a focused bug report or a proposed change in [GitHub issues](https://github.com/scottconverse/rigwell/issues). Describe the observed behavior, expected result, operating system and version. Review diagnostic archives before sharing them. Never include credentials, private transcripts or private repository files.

## Development setup

Use Bun 1.4.4, Node 22, Git and ripgrep. Clone the repository. The default branch is `main`:

```sh
git clone https://github.com/scottconverse/rigwell
cd rigwell
bun install
cd desktop
npm ci
cd ..
bunx tsc --noEmit -p .
bun test
```

On Windows, if Electron's executable is missing after installation, run `node node_modules/electron/install.js` from `desktop`. Native desktop tests need the appropriate desktop dependencies; Linux CI runs them under a virtual display. The Windows sandbox and Linux-only packaging checks are platform-specific by design.

## Changes and tests

Read [the specification](../spec/harness-spec.md), [design decisions](decisions.md) and relevant source before changing behavior. Keep changes focused, add meaningful regression coverage for defects, and run affected checks plus the required workflows. Tests use fake providers and temporary profiles. Live-model acceptance is a separate, manually authorized activity.

Do not copy material from `evidence/`. Preserve third-party notices and licenses. Do not commit credentials, personal runtime settings, actual model identifiers or private test transcripts. Use generic configuration placeholders in examples. Keep prose and code free of the em dash character.

Send changes as a pull request to `main`. Record material design choices in `docs/decisions.md` and preserve current acceptance and remaining work in `docs/handoff/HANDOFF.md`.

## Documentation and website

The [user manual](user-manual.md) covers installation, everyday use and architecture. Source for the public site is in `website/`; see [website maintenance](../website/README.md) for build, preview and deployment. Documentation should describe observed behavior and qualify unverified integrations.

## License

Contributions are under [AGPL-3.0-only](../LICENSE). Existing third-party attribution is in [NOTICE](../NOTICE).
