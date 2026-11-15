---
name: install-code-review
description: Set up a local automation to review new PRs or pushes to a chosen branch.
---

Use InstallLocalService with service "code-review". Establish the GitHub owner/name, local project folder and run profile. Choose source "pull-request" (new and updated PRs) or "push" (an exact branch and signed webhook). PR sources can poll or use a signed webhook. Reuse Code providers or a named stored GitHub credential; never request tokens in chat.

Show the complete settings and ask whether results should stay in local reports (postResult false, the default) or be posted to the verified source (postResult true). Installation always goes through Rigwell's actual approval prompt. Never install on an ambiguous request. Creating the automation does not start a run. It uses the review skill, saves findings in its reports folder and runs only while the daemon is running. An unattended run cannot approve more work.

For webhooks explain how to use the existing automation hook URL and secret via the owner's tunnel, without printing the secret. Do not silently register a GitHub hook or enable posting. Use ReadAutomation and the Automations page for history, pause, edit and removal. State missing credentials or source access. Never promise a review before it has run.
