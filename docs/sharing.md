# Share and import sessions

The session menu exports redacted HTML or Markdown through a save dialog. Copy as Markdown uses the same
redacted export. Attachments, private reasoning and hidden context are omitted. Exports contain visible text,
including textual tool activity, plus an inert versioned payload so Rigwell can import them. HTML is escaped and
has no scripts or external assets. Markdown fences the transcript and escapes its title.

Redaction removes configured named/keychain-referenced secret values, recognized credential forms, secret fields,
private-key bodies, bearer tokens and credential assignments. This is not a guarantee that arbitrary unlabeled
private information is recognized. Review the generated file before sharing it.

Copy share link creates an **unlisted GitHub gist** only after the permission prompt states the destination and
warning and you approve. Anyone who obtains the link can read it. Use the existing GitHub connection with gist
permission; no API-key or paid-model fallback is used. Cancel sends no upload. Creating a gist is optional: local
exports work without a GitHub connection. Copy session link remains a local Rigwell deep link.

Open Import session from the sidebar/palette and choose a file or paste an HTTP(S) URL, including an unlisted gist
link. Imports are stored separately, read-only, with no composer or executable tool state. Choose a working folder
and Fork into new session to continue as a new text-only session with autonomy off. Existing project-trust and
permission checks apply when it runs. Import/fork alone runs no model or tool.

CLI examples:

```
rigwell export <session-id> shared.html
rigwell export <session-id> shared.md
rigwell import shared.html
rigwell import https://gist.github.com/<account>/<gist-id>
rigwell import shared.md --fork --cwd <folder>
```

CLI exports refuse to overwrite an existing file. Import prints the local read-only deep link and, when requested,
the separate fork ID. Files and streamed responses are bounded to ten MiB; imports refuse redirects, credentialed
URLs, unsupported schemes, malformed payloads and executable roles. Gist imports send no account token and check
the canonical raw-file host before reading a truncated file. No imported HTML is executed.

Fake-service and headless checks cover these boundaries. No real gist upload is part of automated acceptance.
Session sync and owning-machine leases are the remaining portion of spec 20.8 and are not delivered by this slice.
