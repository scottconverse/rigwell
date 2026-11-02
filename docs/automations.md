# Automations: methods for clients

Everything here is a protocol method (prefix `rigwell.`) on the daemon connection. The automation list, create, update, pause,
resume, run, history and cron methods are described in `src/automations/index.ts`; this page covers the Wave 3 extras
that a client UI needs (decisions 255 to 257).

## Templates

`rigwell.list_automation_templates {}` returns `{templates}`. Each template:

| Field | Meaning |
| --- | --- |
| `id`, `name`, `description`, `category` | Show these in a gallery. Categories: health, dependencies, testing, release, git |
| `schedule` | Default schedule text (shown as the preselected schedule) |
| `autonomy` | Default autonomy for runs |
| `parameters[]` | `{key, label, description, default?}`: render one input per entry, prefilled with `default`. Without a `default` the value is required |
| `instructions` | The run prompt with `{{key}}` placeholders, for a preview |

`rigwell.create_automation {templateId, parameters?: {key: value}, ...overrides}` creates the automation from a template.
Any normal create field you send (`name`, `schedule`, `timezone`, `model`, `workingDirectory`, `instructions`, `projectDir`...)
replaces the template's value. An unknown template id or parameter key fails with invalid params (-32602) and a message.
The result is the usual `{automation}`. Creating never starts a run.

## Visual page

`rigwell.get_automation_visual {id}` returns `{path, html, generated}`.

- `path` is the absolute path of `<automation folder>/VISUAL.html`.
- `html` is the page. Show it in a sandboxed frame (`sandbox` with no `allow-same-origin`, or an `srcdoc`). It loads nothing from
  the network. To theme it, post `{type: "theme", theme: "light" | "dark" | "auto"}` to the frame; without a message it follows
  `prefers-color-scheme`.
- `generated` is false when the user or the agent wrote their own page; Rigwell never overwrites such a page.

The file is rebuilt after every run and on create and edit. Refresh the frame when `rigwell.automation.auto_paused` arrives,
when the client's own `run_automation` call finishes, or on a timer while a run shows `in_progress` in the history.

## Create by chatting

`rigwell.start_automation_setup {cwd, templateId?, templateParameters?, modelId?, ...}` starts a session on the connection (the
same as `initialize_session`, so the connection must not already have one) and returns the usual initialize result with
`automationSetup: true`. The session is titled "Automation setup" and carries the tag `automation-setup`. Then use the session
like any other: send the user's text with `add_user_message`, render the transcript, and answer `request_permission` and AskUser
requests. The agent interviews the user and calls the `CreateAutomation` tool after the user says yes; that tool call arrives
as a permission request (confirmation type `exec`, `details.toolName` is `CreateAutomation`, `details.input` holds the
proposed name, schedule, instructions and so on), so the UI can show it as a review card.

When the session sees `CreateAutomation` succeed, refresh the list with `list_automations`. If the client wants the setup to
begin from a gallery choice, pass `templateId` (and `templateParameters` already collected).

The agent can also use `ListAutomationTemplates` and `PreviewSchedule` (both need no approval).
