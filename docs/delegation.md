# Slack and Teams delegation

Delegation is off by default. Settings, Slack and Teams lets you choose local project aliases/folders and model profiles, the workspace/tenant, explicitly allowed user IDs, and existing stored secret names. Saving asks you to confirm that access. Send `alias: your request` to the app; reply in its thread to continue. `/stop` interrupts the thread's active session. Changing access stops the existing delegated engines. Transcripts remain available.

These are normal daemon-owned Rigwell sessions, with the same Session loop, model adapters, Workstream/mission tools, hooks, trust and approval gates. They start at autonomy Off. The configured profile can use the existing signed-in subscription client or a direct/local adapter. No additional agent loop or credential import is introduced. The desktop sidebar updates when delegated messages arrive, shows a Slack/Teams source badge, and opens the same live engine and pending prompts. The transcript header also shows the persisted source tag.

## Slack setup

1. Use the Socket Mode app configured for automation triggers, or register your own Slack app. Enable Socket Mode and Interactivity. Create an app-level token with `connections:write`. Install the app to the workspace and obtain its bot token.
2. Give the bot `chat:write`, `app_mentions:read` and `im:history`. For replies in public/private channel threads, give the corresponding `channels:history`/`groups:history` scopes and invite the bot to the channel. Subscribe to `app_mention`, `message.im`, `message.channels` and `message.groups` for the surfaces you use. Reinstall after scope changes.
3. Store the app and bot tokens as named secrets in Settings, API keys. Enter those names, your Slack workspace ID and allowed user IDs in delegation settings. Tokens are never embedded in the project mapping.
4. Add a project alias and folder, enable Slack and confirm Save. Mention the app with `alias: request`, or send that text in a DM. Continue in the resulting thread. Other users and workspaces, bot messages, edits and unrelated channel messages cannot start a session.

Automation triggers and delegation share one Socket Mode connection for the same app/bot secret pair. Each consumer durably records/filter events before acknowledgement. Disconnecting one consumer does not disconnect another. Buttons travel over that authenticated socket; Rigwell does not accept unsigned HTTP Slack actions or model-provided reply URLs.

## Teams setup

1. Register a single-tenant Bot Framework bot and a Teams app that uses that application ID. Enable the Teams channel and install the app in the intended personal/group/team scope. Keep its tenant and application IDs available.
2. Store the bot application's client secret as a named secret in Rigwell. Configure that name, the tenant/application IDs and explicitly allowed users' Microsoft Entra object IDs. Display names and email addresses are not authority.
3. Run your own HTTPS tunnel to the chosen loopback port, for example `cloudflared tunnel --url http://127.0.0.1:47824`. Register the full messaging endpoint `https://your-tunnel-host/api/delegation/teams` with the bot and in Rigwell settings. Preserve the Authorization header. Rigwell does not provision or start a public tunnel.
4. Add a project, enable Teams, confirm Save and send `alias: request`. Personal chats reuse that conversation; channel replies remain scoped to their originating conversation/thread.

The listener binds only 127.0.0.1 and exposes only the Teams POST route. Each request must pass RSA-SHA256 signature verification against the fixed Bot Framework OpenID/JWKS trust source, channel endorsement, exact issuer/application audience, expiration/not-before, signed service URL, configured tenant and user checks. Emulator/anonymous authentication is not supported. Outgoing tokens use single-tenant client credentials with the Bot Framework scope and are cached only in memory. Replies go only to the verified commercial Teams service hosts (`smba.trafficmanager.net`, `smba.infra.teams.microsoft.com`) and originating conversation. Redirects are refused. No endpoint or signing trust-root override is accepted through configuration/RPC; dependency injection exists only for fake-service tests.

Protocol references: [Bot Connector authentication](https://learn.microsoft.com/en-us/azure/bot-service/rest-api/bot-framework-rest-connector-authentication?view=azure-bot-service-4.0), [Teams Adaptive Card actions](https://learn.microsoft.com/en-us/microsoftteams/platform/task-modules-and-cards/cards/cards-actions), [Slack Socket Mode](https://docs.slack.dev/apis/events-api/using-socket-mode/).

## Questions, approvals and recovery

Progress includes assistant text and one notice per tool call; it excludes hidden reasoning and tool output. Text updates coalesce over two seconds. Replies are plain text, bounded and redacted with the existing configured-secret scanner. Long previews explicitly point to the full Rigwell transcript. Chat is not a complete transcript export.

Permission buttons carry only random, one-use values bound to the actual pending request, original user and conversation (and Slack thread). They expire after thirty minutes or when the request resolves, access changes or the daemon stops. A question supports option buttons, multi-select/submit, cancellation and a text reply, one question at a time. An answer in the desktop resolves that same request and invalidates its chat buttons. Project trust is temporary to the session and never silently remembered. If permission details exceed the chat preview, only Cancel is offered there; review/approval must use the complete Rigwell prompt in the desktop.

Private state is under `<Rigwell home>/delegation/`: configuration contains secret references, and SQLite retains source-event IDs, the bounded queue and source/session bindings. Up to sixteen engines may be attached and one thousand events may wait. Queued events survive restart; duplicates stay seen. Admission is recorded before running. If the daemon dies after admission, that event is shown as uncertain and never automatically repeated. A subsequent message can reopen its stored session; this does not automatically replay interrupted tools. Uncertain outbound delivery is logged, without blind retries. Failed listener/configuration changes leave delegation disabled, rather than leaving partial access active.

Local RPC: `get_delegation_status`; `configure_delegation {config, confirmed:true}`. These expose no stored token values. They are local administrative methods, not agent tools or public tunnel routes.

Acceptance uses fake Slack HTTP/Socket Mode, signed fake Teams/JWKS/OAuth/Connector responses, fake model servers, actual Rigwell engines and headless production desktop components. It covers source/user rejection, shared sockets, persisted deduplication, restart/resume, uncertain admission, questions, trust, approved and denied writes, revocation, clipped approval details and desktop source badges. It establishes no real Slack installation, Teams registration, tunnel or live workspace delivery. Those require the owner's registered apps, locally stored credentials and chosen user IDs.
