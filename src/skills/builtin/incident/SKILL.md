---
name: incident
description: Guide the response to a production incident: triage, mitigation, evidence gathering, communication notes and a blameless postmortem draft.
---
# Incident response

Help the user work an incident methodically. Stay calm, favor reversible actions, and write down what you learn as you go.

## 1. Triage (first minutes)

- Ask or determine: what is broken, since when, who is affected, how bad (partial or total, data loss or not).
- Assign a severity with the user: sev1 (outage or data loss), sev2 (major feature degraded), sev3 (minor).
- Name an incident lead and keep a running timeline: timestamp, observation or action, who did it. Keep it in a scratch file.

## 2. Stabilize before diagnosing

- Ask what changed recently: deploys, config or flag changes, migrations, traffic spikes, dependency or provider issues. Check `git log` and release history.
- Prefer the quickest safe mitigation: roll back, disable the feature flag, scale up, fail over. Confirm with the user before any production-affecting command; do not run destructive commands on your own.
- After mitigating, verify with the same signal that showed the problem.

## 3. Find the cause

- Read the error logs and metrics the user provides or that are available locally. Find the first occurrence and what is common to the failing requests.
- Form hypotheses, then test the cheapest one first. Reproduce locally or in a test when possible.
- Keep fixing and understanding separate: ship the smallest fix, with a regression test, then investigate deeper.

## 4. Communicate

Draft short status updates on request: what we know, impact, what we are doing, next update time. Avoid speculation and blame.

## 5. Postmortem draft

Once resolved, write a blameless postmortem: summary, impact (duration, users, data), timeline, root cause and contributing factors, what went well and badly, and action items each with an owner and priority. Focus on systems and process, not individuals.
