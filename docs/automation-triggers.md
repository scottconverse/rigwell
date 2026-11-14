# Event automation triggers

Automations can run on a schedule, a general webhook, GitHub activity, CI failure, Slack activity or the final outcome of another automation. Use New automation in the desktop, the existing automation RPC/tools, or edit its HEARTBEAT.md. Creating an automation saves it without immediately starting a model run. External events are untrusted input and use the existing unattended engine: actions needing a user approval are denied, including automation mutations. Keep the daemon running for polling, Socket Mode, dispatch and result delivery.

## GitHub and CI

Choose repositories as `owner/name`, selected events, and optional label or handle filters. Events are issue opened/labeled, PR opened/updated, a comment mentioning the configured handle, review requested, failed check or failed workflow. CI triggers allow only checks/workflows and require an explicit watched branch. Polling defaults to two minutes; configurable intervals range from one minute to one day. Pagination, response limits and errors are handled explicitly. A five-minute overlap catches late indexing without replaying already seen IDs. Events predating the automation are ignored. Polling observes PR update timestamps; webhook updates use edited, synchronize and reopened actions. Check polling observes the selected branch's current Git reference; workflow failures are queried for the watched branch.

The default connection is the existing GitHub Code providers account, including OAuth refresh. Public repository reads can work without a connection. An optional token name refers to a named secret saved under Settings > API keys. A missing explicitly named secret fails; it does not silently use another account or anonymous access. No tokens belong in HEARTBEAT.md.

Example frontmatter, with normal automation instructions after the closing delimiter:

```yaml
---
name: "Review incoming activity"
trigger: "github"
eventTrigger: {"repos":["owner/repository"],"events":["pr_opened","pr_updated"],"pollMinutes":2}
postResult: false
autonomy: "low"
---
Review the changed code and save a report.
```

For GitHub webhook delivery, choose webhook transport. Creation shows a signing secret; the detail page shows `/hooks/<automation-id>` and the listener port. Configure your own HTTPS tunnel to this local listener, select GitHub's events and set that signing secret. The receiver checks `X-Hub-Signature-256` over the complete bounded raw body, requires a delivery ID, filters repository/event/branch and stores that ID before acknowledging admission. No tunnel or remote webhook registration is created automatically. Rotate the existing automation secret when needed.

Any CI system can also call an ordinary Webhook automation with the existing bearer or HMAC authentication. This route accepts its payload as untrusted context and has the existing payload filter, duplicate window and run caps. GitHub/CI event triggers instead retain durable source-event IDs across restarts.

## Slack

Register your own Slack app, enable Socket Mode and subscribe it to the events you need: `app_mention`, `message.im` and channel message events for channels where it is installed. Store its app-level token (`connections:write`) and bot token in Settings > API keys; enter only their secret names in the trigger. Bot permissions depend on subscribed events and channels, typically `app_mentions:read`, `im:history`, `channels:history` or `groups:history`; replies need `chat:write`. Install/reinstall the app in your workspace after changing scopes.

Select app mentions, DMs and/or channel messages. Channel messages require explicit channel IDs. An optional text pattern uses `*` and `?` wildcards; `*` matches everything. Optional channel IDs also restrict mention/DM triggers when supplied. Bot-generated messages and message subtypes are ignored to prevent reply loops. Automations sharing an app/bot credential pair share one Socket Mode connection. The client handles disconnects with bounded reconnect backoff and does not need a public URL. Durable enqueue/filtering precedes envelope acknowledgement; a full queue leaves the event unacknowledged for Slack to retry. No real Slack app is included or registered by Rigwell.

## Chaining and delivery

Choose named source automations and Success, Final failure or Either. A failed first attempt waits for its existing retry before producing a failure outcome. Chain context persists through retries. An automation cannot trigger an ancestor in the same chain, and depth is bounded at sixteen, preventing cyclic configurations from running forever. Paused targets do not accept new source events; already queued events stay inactive until resumed.

Each event trigger has a private SQLite ledger under its automation's memory directory. It retains source IDs until deletion, queues up to 1,000 pending events, respects concurrent-run limits and keeps hourly admission counts beyond the trimmed visible run history. Restart reconciles already registered run IDs rather than launching them twice. Like ordinary automations, a daemon crash marks interrupted runs failed; exactly-once completion across arbitrary process or network failure is not claimed. Sync does not replicate this live queue; restored automations remain paused.

Results stay in Rigwell by default. Enable **Allow posting run results back to the source** to allow a redacted result to be posted to the verified originating GitHub issue/PR or Slack thread. The model cannot choose another destination. Named secret values and common credential patterns are scrubbed; Slack markup and link unfurls are disabled. If a reply's delivery becomes uncertain, the ledger shows `reply unknown` and its error. Rigwell does not automatically resend an uncertain reply; inspect the source before posting manually. Disabling posting or pausing prevents queued replies from being sent. The detail editor exposes the configuration and delivery status.

Local acceptance uses fake GitHub HTTP endpoints, a fake Socket Mode server and fake model providers only. It checks every event kind, real engine dispatch, HMAC/target filtering, pagination, credential references and redirect rejection, restart deduplication, bounded payloads and admission caps, final-outcome chaining, cycle prevention, explicit result posting/redaction and production desktop forms. Real account scopes, GitHub indexing/tunnels and Slack workspace delivery remain unverified until configured by the owner.

Protocol references: [GitHub issue events](https://docs.github.com/en/rest/issues/events), [check runs](https://docs.github.com/en/rest/checks/runs), [workflow runs](https://docs.github.com/en/rest/actions/workflow-runs), [webhook signatures](https://docs.github.com/en/webhooks/using-webhooks/validating-webhook-deliveries), [Slack Socket Mode](https://docs.slack.dev/apis/events-api/using-socket-mode/) and [thread replies](https://docs.slack.dev/reference/methods/chat.postMessage/).
