---
name: wiki
description: Build and incrementally refresh local project documentation with source citations and dependency diagrams.
---

Establish the selected repository folder, then run `rigwell wiki build --cwd <folder>` through the normal execution tool. Quote paths for the active shell. This writes only managed documentation under `.rigwell/wiki`; it does not run project scripts, hooks, a model service or package installation. Review the returned coverage warnings, page names and changed files before reporting success.

The overview describes the repository map and cites its README and package metadata. Architecture diagrams show resolved relative imports. Module pages enumerate parsed declarations and their line locations; the glossary indexes those symbols. These are source observations, not proof of runtime behavior. Open the cited implementations when answering a behavioral question and distinguish inferred responsibilities from observed declarations.

Use `rigwell wiki update --cwd <folder>` after edits. It refreshes affected managed pages, removes pages for deleted modules and preserves unrelated files. Read pages with `rigwell wiki read overview.md --cwd <folder>` or use the desktop Wiki page. Do not add generated wiki artifacts to version control unless the user explicitly requests that. A failed build, missing parser result or excluded file is an omission to report, not a reason to invent documentation. Use install-wiki only when the user wants ongoing updates.
