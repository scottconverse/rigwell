---
name: install-qa
description: Set up a local automation to start an approved dev server and test changed browser flows.
---

Use InstallLocalService with service "qa" after establishing the GitHub owner/name, existing local project folder, run profile, user-approved devCommand, loopback HTTP(S) url and concrete flows to test. Choose new/updated PRs or signed pushes to one exact branch. Explain that the local checkout must already match the event's head commit; QA reports a mismatch as not checked and never automatically checks out incoming code.

Show all settings, the command and whether final reports may be posted to the verified source. Reports remain local by default (postResult false); choose true only when the user explicitly wants source comments. InstallLocalService always requires Rigwell's actual approval, even at high autonomy. Creating it does not start a run; the daemon must be running for triggers to dispatch.

Each run loads agent-browser, starts only its approved server as an owned background job, waits for readiness, drives changed flows using accessibility refs and reports observed results and omissions. JavaScript evaluation needs interactive approval and is unavailable unattended. Close the owned browser and stop the owned server, including on failure. Do not stop unrelated servers or present their responses as evidence for this checkout. Use ReadAutomation and the Automations page to inspect reports, pause, change settings or remove the service. Never print webhook secrets or register remote hooks silently.
