---
name: init
description: Create or refresh the AGENTS.md file that tells coding agents how to build, test and work in this repository.
---
# Initialize AGENTS.md

Goal: produce a short, accurate AGENTS.md at the repository root so future sessions start with the right commands and conventions.

## Steps

1. Check whether AGENTS.md (or CLAUDE.md) already exists. If it does, read it first and plan to update it, keeping anything that is still true and was written by a person.
2. Learn the project from facts, not guesses:
   - Read the README, the package or build manifest (package.json, pyproject.toml, Cargo.toml, go.mod, Makefile, and similar).
   - Look at CI configuration to find the real build, lint and test commands.
   - Skim the top-level folders and a few representative source and test files to see naming, layout and style.
3. Run the cheap commands you plan to document (a version check, a lint run, a single test file) to confirm they work. Never document a command you have not seen succeed or seen in CI.
4. Write the file with these sections, skipping any that have nothing useful to say:
   - **Overview**: one or two sentences on what the project is.
   - **Commands**: install, build, lint, typecheck, run one test, run all tests.
   - **Layout**: the folders that matter and what lives in each.
   - **Conventions**: formatting, naming, error handling, test style, commit style.
   - **Gotchas**: things that surprised you, required environment variables, slow or flaky steps, generated files that must not be edited by hand.
5. Keep it under about 100 lines. Prefer bullet points and exact commands in code spans. Do not paste large excerpts of other docs; link to them.

## Rules

- Do not invent policies. If you could not verify something, leave it out or mark it "unverified".
- Do not include secrets, tokens or personal paths.
- In a monorepo, put shared guidance at the root and add a short AGENTS.md inside a package only when that package differs.
- Finish by telling the user what you wrote and what you could not confirm.
