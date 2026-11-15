# Inbox and email alerts

The desktop Inbox collects permission requests, agent questions, finished turns, automation results, mission events and Workstream events from the existing daemon engines. It does not run another agent or answer requests. Open source takes you to the session, automation, Mission Control or Workstream where the normal controls apply.

Filter by category or unread status, mark individual items read/unread, and use Load older items or Newest items to navigate history. Read state persists across restarts. Event identities deduplicate turn results and prompt requests; stable timestamp/ID cursors preserve simultaneous events. The private SQLite store is under `<Rigwell home>/inbox/inbox.db`. It retains the latest 5,000 resolved items, plus pending items. A daemon restart labels old prompt records resolved or interrupted; opening the source establishes its current state. It does not replay old permission requests or grant authority.

Workstream member events are observed once at their owner, independently of open desktop pages. Each member question points to its Workstream and tracks that member's actual session/request ID. A lead finishing its turn does not resolve a member question. Live views of an existing engine do not duplicate its Inbox events. Mission store notifications and final automation results use their existing service paths. Output text and hidden reasoning are not copied into the Inbox; summaries use the configured-secret redactor.

## SMTP setup

1. Store your SMTP password as a named secret in Settings, API keys. Do not paste it into an email form or configuration file.
2. Open Settings, Email alerts, or Email alerts from the Inbox. Enter the SMTP hostname and port, username, stored password name, sender address and one recipient address.
3. Select TLS immediately for the server's implicit TLS port, usually 465. Otherwise Rigwell requires STARTTLS, usually on port 587. Server certificates are verified; plaintext fallback and certificate-verification overrides are not offered.
4. For each of the six categories select Off, Immediately or Daily digest. Set the daily hour in this machine's local time (0-23). Email is disabled by default. Enable and confirm the exact server, recipient and frequencies before any future event can queue mail.

Alerts contain redacted, bounded summaries and `rigwell://` source links. They do not contain tool arguments, attachments, hidden reasoning or an approval endpoint. Review the complete prompt and approve in Rigwell. The email client and installed app must support the registered protocol for links to open automatically; source IDs remain readable in the message.

Daily items are scheduled for the next configured local hour. If the daemon is stopped then, delivery catches up when it runs again. Pending items survive restart. A digest groups up to 100 due items; larger backlogs are sent in successive bounded batches. Immediate alerts are sent individually. Changes to settings cancel existing queued alerts and apply to new events, preventing old messages from being silently redirected to a new recipient. Existing Inbox history stays available.

Before SMTP I/O, delivery is recorded as sending. A failure, interrupted send or crash in that window becomes uncertain and is not automatically retried, since the server might already have accepted the message. Settings shows those counts and the redacted last error. Check the mail server before taking further action. Disabling or reconfiguring waits for the active send to finish; daemon shutdown aborts it. No mail is sent just to save settings, and historical Inbox items are not retrospectively emailed.

Configuration is `<Rigwell home>/inbox/email.json`, with a credential reference rather than the password. Local administrative RPC methods are `list_inbox {category?, unread?, before?: {at,id}, limit?}`, `mark_inbox {ids,read}`, `get_email_alerts` and `configure_email_alerts {config,confirmed:true}`. They are not agent tools or phone/public listener methods. The daemon broadcasts `inbox_changed` without item contents. The desktop refreshes its current page periodically.

SMTP uses pinned Nodemailer, its abort signal support and normal certificate validation. File/URL message access, debug logging, attachments and model-chosen destinations are disabled. Protocol documentation: [SMTP transport](https://nodemailer.com/smtp), [message configuration](https://nodemailer.com/message).

## Verification limits

Acceptance uses actual daemon engines with fake model services, headless production desktop components and a local fake SMTP server with an explicitly trusted fixture certificate. It verifies real question/source routing and answers, persisted read state, all six event categories, independent Workstream prompts, confirmation, immediate/digest scheduling, restart catch-up, uncertain recovery, redaction, verified TLS authentication, rejection of plaintext/untrusted certificates and cancellation closing the active connection. No real SMTP credentials, message delivery to an external mailbox, installed protocol handler or hardware notification behavior is inferred from those tests.
