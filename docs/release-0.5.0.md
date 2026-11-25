# Rigwell 0.5.0 on Windows

Windows x64 moves to **0.5.0**. Linux and macOS distributions remain at **0.4.0**.

- [Signed Windows x64 installer](https://github.com/scottconverse/rigwell/releases/download/v0.5.0/rigwell-setup-0.5.0-x64.exe)
- [Release assets, checksums and signing receipt](https://github.com/scottconverse/rigwell/releases/tag/v0.5.0)
- [User manual](user-manual.md) and [installation guide](install.md)

## Desktop look

- A sidebar with icons and Pinned, Workstreams and Projects sections.
- A Home screen with the Rigwell mark, heading and folder chips.
- A Session screen with message box chips, an icon send button and a centered transcript.
- Settings rows with hints, switches and theme cards.
- An Automations banner and template cards.
- Cards, pill badges, quiet tables and underline tabs on pages.
- A new look for menus, dialogs and the command palette.

## Workstreams

- Start a Workstream from a template, with a role picker.
- Version history for the shared folder: a Shared files section with a list, history, View and Restore.

## Automations

- A CI workflows tab.
- 16 automation templates, up from 6.
- The gh templates rate read-only gh commands low risk and read gh output directly.

## Analytics and setup

- Badges on the Stats page.
- A Finish setup card in the sidebar.

## Known limits

- Shared file history is kept on this computer only. Two agents that run shell commands in the same shared folder at the same moment can, in some timing, label a file with the wrong writer.
- Rigwell refuses a stale write only from its own file tools. Shell commands and hand edits are recorded but not refused.
- After a Restore, another open Rigwell window shows the change at the next workstream update.
- Shared file history for a member on a second machine has not been tested on real hardware.
- The gh automation templates tell the model to read gh output directly and to use only read-only commands. This is an instruction to the model, not a block. A model can still run a command that an unattended run refuses.
- Mission token use can still vary. Set a spend limit before you run a Mission on a paid model.

The [0.4.6 release notes](release-0.4.6.md) describe the preceding release.
