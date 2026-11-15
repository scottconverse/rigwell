export interface Lesson { id: string; title: string; body: string; file: string; goal: string; starter: string; example: string }
const json = (v: unknown) => JSON.stringify(v, null, 2) + "\n";
export const LESSONS: Lesson[] = [
  { id: "getting-started", title: "Getting started", file: "AGENTS.md", goal: "Write project instructions with a Scope section and a Validation section, each with a concrete rule.", starter: "# Sample project\n\n## Scope\n\n## Validation\n",
    example: "# Sample project\n\n## Scope\n\nWork only inside this sample repository. Preserve unrelated edits.\n\n## Validation\n\nInspect the change and run the relevant tests before claiming completion.\n",
    body: `# Getting started

Choose a project folder in New Session, then select an already configured model profile. Rigwell begins with read-only autonomy unless you choose another level. Describe one concrete outcome, including the files or behavior involved and what would establish success. A useful first task is to explain a small function, then request a bounded change and its relevant test.

Review the folder trust question before enabling project configuration. Trusted instructions, hooks, skills and MCP servers can affect a session. Read a proposed tool action before approving it. A plan or streamed answer does not establish that edits or tests finished; wait for the final turn result and inspect the evidence.

This practice repository is disposable and separate from your existing projects. Edit AGENTS.md below to give the sample clear scope and validation instructions. Check practice validates those two sections without invoking a model or executing file contents. Open sample session takes you to Rigwell's normal New Session screen for this folder; sending a real task uses the selected profile and normal approvals. Changes made here do not configure your other repositories.

The command-line equivalent is rigwell exec --cwd <folder> followed by your prompt. Use --auto low only when you intend to permit that level. Stop cancels owned work; it does not erase your edits.`,
  },
  { id: "models-and-keys", title: "Models and keys", file: "model.json", goal: "Describe a key-free local Chat Completions profile using provider generic-chat-completion-api, a model placeholder and a loopback HTTP baseUrl.", starter: json({ provider: "", model: "", baseUrl: "" }),
    example: json({ provider: "generic-chat-completion-api", model: "local-model", displayName: "Local practice", baseUrl: "http://127.0.0.1:1234/v1" }),
    body: `# Models and keys

Rigwell separates the selected profile from its own Session loop. Settings lets you configure provider endpoints, model identifiers, capability options and connected accounts. A profile's existence does not prove that its endpoint is reachable or that your account can access its selected model.

Signed-in native client profiles use their official clients for subscription sign-in, refresh and native coding tools. Rigwell retains the outer Session lifecycle and coordination. Direct HTTP adapters instead use the configured API/account route. Subscription access and separately billed API access are different choices; do not silently switch between them.

Store secrets through the credential settings or rigwell credential set, which reads its value locally from stdin. Never put a real token in this lesson, a prompt, a committed settings file or a screenshot. Use Rigwell's credential references in real configurations. OAuth also needs the provider's supported flow and registered client details; an API key does not supply an app registration.

Practice with a key-free loopback profile. Check practice validates its shape with the actual model configuration validator and makes no connection or inference request. The placeholder is for learning the format, not an available model claim. Configure an installed local model in normal Settings when you want to test real access.`,
  },
  { id: "skills", title: "Skills", file: ".rigwell/skills/academy-example/SKILL.md", goal: "Create a skill named academy-example with valid frontmatter, a useful description and nonempty instructions.", starter: "---\nname: academy-example\ndescription: \n---\n",
    example: "---\nname: academy-example\ndescription: Inspect a small sample change and report its verification evidence.\n---\nRead the relevant files. Explain the intended behavior, make only the requested change, and report the exact affected checks and their results.\n",
    body: `# Skills

A skill is reusable instructions in a SKILL.md file. Its frontmatter gives a name and description; the body explains when and how to do the work. Project skills live in .rigwell/skills/<name>/SKILL.md. Rigwell also loads user, approved plugin and built-in skills with documented precedence. A project definition can override a built-in name, so inspect unexpected overrides.

The agent discovers enabled skills and loads their full instructions through Skill. Loading a skill does not establish that its commands ran. A useful skill identifies inputs, bounded actions, relevant checks and what evidence to report. Keep secrets and unrelated project history out of reusable instructions.

Write the sample skill below and check it with the same parser Rigwell uses. The check reports format errors and warnings; it does not execute the body. Open a normal sample session when you want an agent to invoke the skill and demonstrate actual behavior. Review tool approvals separately, including when a skill asks for a command, network access or an automation.

Use Settings to disable an unwanted skill. Changing source affects newly loaded configuration; do not assume a running session has forgotten instructions it already received.`,
  },
  { id: "hooks", title: "Hooks", file: ".rigwell/hooks.json", goal: "Define SessionStart with one command hook whose command is echo academy-ready.", starter: json({ hooks: { SessionStart: [] } }), example: json({ hooks: { SessionStart: [{ hooks: [{ type: "command", command: "echo academy-ready" }] }] } }),
    body: `# Hooks

Hooks run configured commands at named Session events, such as SessionStart, PreToolUse and Stop. They are executable project configuration, not comments. Folder trust and managed-hook policy determine which definitions may load. Inspect both the command and its event before trusting a repository.

Project hooks can be placed in .rigwell/hooks.json. Each event contains groups with a hooks array; a command hook has type command and a command string. Optional matchers narrow tool-related events. On Windows the configured command uses the Windows command shell; other platforms use sh. Quote paths for the platform and prefer short, predictable commands.

This exercise defines a harmless echo command for SessionStart. Check practice validates the event structure with Rigwell's normal hook normalizer but does not execute it. A real hook runs only through a normal trusted session, where its output and exit result can be inspected. A saved configuration or successful format check is not evidence that the event fired.

Avoid placing credentials in hook commands or logs. Keep failure behavior understandable, and never use a hook to silently install packages, change unrelated files or send data elsewhere. Use the session's hook diagnostics to investigate failures.`,
  },
  { id: "mcp", title: "MCP connectors", file: ".rigwell/mcp.json", goal: "Describe one stdio server named academy-example with command bun and args [--version]; do not launch it.", starter: json({ mcpServers: {} }), example: json({ mcpServers: { "academy-example": { type: "stdio", command: "bun", args: ["--version"] } } }),
    body: `# MCP connectors

MCP adds tools and resources supplied by another server. In Settings, inspect a connector's transport, executable or URL, requested values and authentication before connecting. Catalog entries are configuration guidance; they do not establish that a server is installed or trustworthy. Approved plugins can also contribute MCP definitions.

A stdio server runs a local process. HTTP and SSE servers use their configured endpoints. OAuth connectors use resource/issuer discovery and the supported sign-in flow; store secrets through Rigwell's credential handling, never in this practice file. Project MCP configuration is subject to folder trust, and tool use still goes through the session's policy.

The example below intentionally uses bun --version only to learn the stdio configuration shape. It is not an MCP implementation and would not complete an MCP handshake. Check practice validates the saved definition without launching any executable or making network requests. Configure an actual server in normal Settings only when you intend to connect it.

When debugging a real connector, distinguish executable lookup, process startup, protocol handshake, tool discovery, authentication and a successful tool call. A green configuration check proves none of those later stages. Remove or disable an unused server rather than leaving unexplained tools available.`,
  },
  { id: "worktrees", title: "Worktrees", file: "worktree-notes.md", goal: "Create the sample worktree with the practice action, then record why separate branches and folders matter.", starter: "# Worktree observations\n\n", example: "# Worktree observations\n\nThe academy-practice branch has a separate working folder, so its edits do not alter the main sample checkout. Inspect status and relevant tests before integrating changes.\n",
    body: `# Worktrees

A Git worktree gives a branch a separate working folder while sharing repository history. Rigwell can use worktrees for isolated coding sessions and Workstream members. Isolation reduces accidental file overlap, but it does not automatically resolve conflicting changes or establish that results are ready to integrate.

Start this lesson to create a fresh sample Git repository, then select Create practice worktree. That action operates only on the owned sample repository and creates the academy-practice branch in its worktree folder. There is no remote and nothing is pushed. Write your observation below, then check the actual Git worktree registration and branch identity.

In a real project, inspect the branch, worktree path and current status before starting work. Verify affected tests and review the diff before asking for a PR. Rigwell's Create PR path confirms before pushing; a branch with an open PR is protected from automatic worktree deletion. Do not confuse a prepared PR description with a successful push or an open PR.

The sample cleanup action removes only this owned practice repository and its sample worktree after confirmation. Keep any useful edits elsewhere first. It never removes your real project's branches or worktrees.`,
  },
  { id: "missions", title: "Missions", file: "features.json", goal: "Define one pending feature with an id, description, skillName, milestone and concrete expectedBehavior.", starter: json({ features: [] }), example: json({ features: [{ id: "sample-1", description: "Add a local health response", skillName: "backend-worker", milestone: "m1", status: "pending", expectedBehavior: ["The local health function returns ready"], preconditions: [], fulfills: ["A1"] }] }),
    body: `# Missions

A mission organizes a larger outcome into features, worker handoffs and validation. The orchestrator tracks progress while workers implement bounded features. Define expected behavior and acceptance before spending time on a run. A worker's final message is a claim to compare with its files, handoff and verification evidence.

Feature records include stable ids, descriptions, skills, milestones and status. Preconditions describe what must already hold; expectedBehavior explains what the implementation must demonstrate. Validation and completion records are managed state. Do not edit protected progress files to make a failed run look complete.

This exercise writes a sample features.json and uses Rigwell's actual feature validator. It also asks for at least one concrete expected behavior so an empty list cannot count as a useful plan. This checks planning format only. It does not create a live mission, load a worker model, run tests or establish implementation success.

Use Mission Control in a normal session to start an approved real mission. Review its plan, model settings and permission prompts. Watch the actual mission state and reports; streamed text alone does not establish a terminal result. Stop or pause through the mission controls and preserve useful recovery evidence when investigating a failure.`,
  },
  { id: "workstreams", title: "Workstreams", file: "workstream-plan.json", goal: "Describe a title, goal, plan, one member with a role and prompt, and a positive maxWallMinutes budget.", starter: json({ title: "", goal: "", plan: "", agents: [], budget: { maxWallMinutes: 0 } }), example: json({ title: "Sample collaboration", goal: "Add and verify a small helper", plan: "One member implements the helper in an isolated worktree, reports evidence and messages the lead. The lead checks the result.", agents: [{ name: "Helper", role: "implementation", prompt: "Implement the requested helper and report the affected test result." }], budget: { maxWallMinutes: 10 } }),
    body: `# Workstreams

A Workstream lets a lead coordinate persistent member sessions with their own workspaces. ProposeWorkstream asks the user to approve the goal, plan and budget before members start. SpawnAgent creates a member; SendMessage and listeners coordinate progress. WaitForEvents waits on observed events rather than requiring continuous polling.

Member permission questions go to the actual user. A lead cannot grant a member authority by sending a message, and a lead finishing does not resolve an independent member prompt. Inspect the roster, member identity, workspace and pending requests when following concurrent work. Interrupt, rename and archive are explicit lifecycle actions.

Write a small plan below, with one bounded member task and a wall-time budget. The practice check validates the plan fields and Rigwell's budget format. It does not approve a Workstream or start members. In a normal sample session, ask the lead to propose the plan, review the real approval, then verify the roster, worktree, member result and message history.

Signed-in subscription clients can receive Rigwell's coordination tools while retaining native coding tools. Rigwell still owns Workstream policy and state. Successful sign-in alone does not establish that a member completed its assigned work.`,
  },
  { id: "automations", title: "Automations", file: "HEARTBEAT.md", goal: "Write valid frontmatter with name, every 5m schedule and high autonomy, plus a concrete local check prompt.", starter: "---\nname: Sample check\nschedule: \nautonomy: high\n---\n", example: "---\nname: Sample check\nschedule: every 5m\nautonomy: high\n---\nInspect this sample repository for pending changes. Report what was observed and what remains unverified. Do not push, publish or change external services.\n",
    body: `# Automations

An automation is a saved prompt and configuration that the daemon dispatches on a schedule or an explicitly configured event. CreateAutomation asks for user approval and saving it does not start a run. Scheduled work occurs only while the daemon is running. Inspect the working folder, model profile, autonomy and posting settings before installation.

HEARTBEAT.md uses frontmatter for fields such as name, schedule and autonomy, followed by the prompt body. Project automations live in .rigwell/automations; user automations live in Rigwell's private home. Reports, history and paused/error states distinguish configuration from actual dispatch and results. Unattended sessions cannot answer interactive permission questions.

Write a sample local check below. Check practice uses the actual heartbeat parser and schedule validator, without registering a scheduled job or calling a model. It requires a concrete prompt so valid scheduling syntax alone is not presented as a useful automation.

For real work, use the Automations page or the approved installer skills. Keep external replies off unless you intend to post to the verified source. Investigate uncertain deliveries before retrying; a failed acknowledgement may not prove that nothing was sent. Pause or remove unused work through the normal controls, and verify the terminal result of owned runs.`,
  },
];
export function lessonById(id: string) { const lesson = LESSONS.find((l) => l.id === id); if (!lesson) throw new Error("Unknown Academy lesson"); return lesson; }
