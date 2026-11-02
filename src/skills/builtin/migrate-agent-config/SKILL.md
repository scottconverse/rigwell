---
name: migrate-agent-config
description: Migrate instructions, skills, commands and settings from another coding agent's configuration into this tool's project layout.
---
# Migrate agent configuration

Help the user bring existing configuration from another coding agent into Rigwell's layout without losing anything or overwriting what is already here.

## Targets

- Project instructions: `AGENTS.md` at the repository root.
- Skills: `.rigwell/skills/<name>/SKILL.md` (project) or `~/.rigwell/skills/<name>/SKILL.md` (personal). The `.agents/skills` folders are also read.
- Commands: Markdown files under `.rigwell/commands/` (project) or `~/.rigwell/commands/` (personal).
- Settings: `.rigwell/settings.json` (project) or `~/.rigwell/settings.json` (user).

## Steps

1. **Find the source.** Ask which tool the user is moving from if it is not obvious, then look for its files: instruction files in the repo root, hidden config folders in the repo and in the home directory, and rule or prompt folders. List what you found and where.
2. **Plan before writing.** Show a table: source file, kind (instructions, skill, command, setting), destination, and any change needed. Wait for the user to confirm when more than a few files are involved.
3. **Convert.**
   - Instructions: copy the substance into `AGENTS.md`. If one already exists, append a clearly titled section instead of replacing it.
   - Skills: each needs frontmatter with a lowercase `name` (letters, digits, hyphens) and a one-line `description`, then the body.
   - Commands: keep the prompt text; rename files to lowercase-hyphen names.
   - Settings: map only the ones that have an equivalent here (permissions allow and deny lists, environment variables, model choice). Do not carry over secrets; ask the user to store keys with the credential command.
4. **Never overwrite** an existing destination file. If there is a name clash, pick a distinct name and tell the user.
5. **Verify.** Re-read each written file, confirm the frontmatter parses, and list what could not be migrated and why (features this tool does not have).

Leave the source files untouched so the user can keep using the other tool.
