---
name: deep-security-review
description: Run a thorough, multi-pass security audit of a codebase or subsystem, with a threat model, per-area checks and a prioritized findings report.
---
# Deep security review

Use this for a full audit of a service, library or large subsystem. For a quick look at a diff, use the security-review skill instead. Expect this to take many steps; keep notes as you go in a scratch file outside the repository.

## Pass 1: understand the system

- Read the README, architecture notes and entry points. Write down what the system does, who uses it, what it stores and which components talk to each other.
- List assets worth protecting (credentials, personal data, money, code execution) and the trust boundaries (internet to server, user to admin, service to service, plugin to host).
- Produce a short threat model: for each boundary, who could attack it and what they would want.

## Pass 2: enumerate attack surface

- Use search to list every place that reads external input, spawns processes, opens files, makes network calls, parses formats, or handles authentication and authorization.
- Group them into areas (for example auth, file handling, API, background jobs, admin tools). Rank areas by exposure and impact.

## Pass 3: audit each area

For each area, starting with the highest rank, read the code end to end rather than sampling. Check injection sinks, access control on every object access, session and token handling, secret storage, cryptography use, error messages that leak detail, race conditions around checks and use, resource exhaustion, and unsafe defaults. Confirm each suspicion by tracing the real data path; if feasible write a failing test or a local reproduction.

## Pass 4: cross-cutting checks

Dependencies and lockfiles, build and CI configuration (secrets exposure, untrusted pull request code), container and deployment files, logging of sensitive values, and test fixtures that contain real credentials.

## Report

Write a report with: scope and what was not covered, the threat model, findings table (id, severity, location, impact, fix, confidence), and a prioritized remediation list. Separate confirmed issues from suspicions. Redact secrets. Offer to fix the high-severity items one at a time, with a test for each.
