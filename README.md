# Rigwell

Rigwell is a local workbench for coding agents. Use a desktop app or terminal to work with your models, coordinate persistent Workstreams, run staged Missions, inspect changes and create pull requests with explicit confirmation. Repositories stay ordinary files and Git branches. Cloud connections send context to the providers you configure.

[Website](https://scottconverse.github.io/rigwell/) · [Downloads](https://github.com/scottconverse/rigwell/releases) · [User manual](docs/user-manual.md) · [Contributing](docs/contributing.md)

## What it does

- Persistent Workstreams with a lead, reusable member sessions, messages, user questions and isolated Git worktrees.
- Direct provider adapters, signed-in official coding clients and compatible local model endpoints. Rigwell owns coordination; native clients retain their own coding tools and permission behavior.
- Desktop conversation, files, terminal, review, Missions, local automations and an Inbox.
- Configurable connectors, plugins, local profiles, policy and spend limits, project knowledge and evaluation history.

## Quick start

For the desktop app, download the package matching your operating system from [Releases](https://github.com/scottconverse/rigwell/releases), then follow the [installation guide](docs/install.md) and [first-task walkthrough](docs/user-manual.md#new-user-guide). Configure a model connection before starting a task. Do not paste credentials into a conversation.

For a source checkout, install Bun 1.4.4, Git and ripgrep:

```sh
git clone --branch phase-1-core-loop https://github.com/scottconverse/rigwell.git
cd rigwell
bun install
bun src/cli/main.ts --help
bun src/cli/main.ts eval tasks
```

Desktop development also requires Node 22:

```sh
cd desktop
npm ci
cd ..
bunx tsc --noEmit -p .
bun test
```

On Windows, if Electron is missing after installation, run `node node_modules/electron/install.js` from `desktop`. See [desktop development](docs/desktop.md) for build and launch commands. The packaged desktop app includes its runtime but does not install a global terminal command.

## Documentation

The [full user manual](docs/user-manual.md) includes new-user onboarding, a nontechnical-user guide, everyday workflows, technical configuration, troubleshooting, recovery and architecture with Mermaid diagrams.

[Authentication](docs/auth.md) · [Review](docs/review.md) · [Evaluations](docs/evaluations.md) · [Release updates](docs/release-updates.md) · [Specification](spec/harness-spec.md) · [Design decisions](docs/decisions.md)

To build the public site, run `bun run site:build` and `bun run site:preview`, then open `http://127.0.0.1:4173/rigwell/`. See [website maintenance](website/README.md).

## Project status

Rigwell 0.4.0 is an early release. The Windows setup installer is signed by Scott Converse, with installed first-run, signed upgrade and rollback evidence. Linux has packaged-install and signed AppImage update/rollback evidence. macOS arm64 packages are unsigned and not notarized; real Mac hardware acceptance is unavailable. Full model-family and long-session qualification remains incomplete. Account access, connector registrations and remote infrastructure require your own configuration.

Current acceptance evidence and remaining work are tracked in [the handoff](docs/handoff/HANDOFF.md). Hosted Stax is [next-version work](docs/next-version.md), outside this release.

## Contributing

Read the [contribution guide](docs/contributing.md), use fake providers in tests, and keep credentials and private runtime data out of Git. Report reproducible issues with the relevant version and platform.

## License

[GNU Affero General Public License v3.0 only](LICENSE) (AGPL-3.0-only). Third-party attribution, including the source of adapted protocol type shapes, is retained in [NOTICE](NOTICE).
