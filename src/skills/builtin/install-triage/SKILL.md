---
name: install-triage
description: Set up local new-issue triage with suggested labels, duplicates and owners.
---

Use InstallLocalService with service "triage", the GitHub owner/name, local project folder and selected run profile. New issues can be polled or delivered by a signed webhook. Reuse the Code providers account or a named stored credential; never ask for tokens in chat.

Explain that the automation reads new issues and project guidance, searches for duplicates and suggests labels and owners with reasons. It does not change labels, assign users or close issues. Suggestions stay queued in local run reports by default (postResult false). Posting a comment to the verified source issue requires explicitly choosing postResult true in the installation settings.

Show the complete settings before InstallLocalService; its real approval prompt is mandatory. Creating the automation does not start a run. It runs only while the daemon is running. For a webhook use the existing hook URL and privately stored secret through the owner's tunnel, never print the secret or silently register a hook. Use ReadAutomation and the Automations page for reports, pause, changes or removal. Report missing source access rather than claiming triage ran.
