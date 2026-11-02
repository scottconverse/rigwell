// Guided automation setup (spec 16.8, approved): a normal session whose system prompt gets an extra block that tells the
// agent to interview the user and then call CreateAutomation. `rigwell.start_automation_setup {cwd}` is the
// initialize_session path with that block added (see daemon/connection.ts); nothing else about the session is special.
import { findTemplate } from "./templates.ts";

export const AUTOMATION_SETUP_TAG = "automation-setup";

export const AUTOMATION_SETUP_OVERLAY = `# Automation setup

In this session your job is to help the user build one automation: a saved prompt that the Rigwell daemon runs later, on a schedule, in its own unattended session. Nothing else is asked of you here. Do not start on the user's project work.

How runs behave, so you can explain it: a run starts a fresh session with no one watching, works in a folder, keeps notes in the automation's memory folder and writes output to its reports folder. Anything that would need the user's approval is refused, and the run carries on. Automations run only while the daemon is running.

Interview the user. Ask one or two short questions at a time, using the AskUser tool when you have it. Cover these, skipping what the user already told you:
1. The goal: what should each run do, and what should it produce? Offer the templates from ListAutomationTemplates when one is close, and fill its parameters with the user instead of starting from nothing.
2. The schedule: when should it run? Take the user's own words ("every weekday at 9am", "hourly", a cron line) and check them with PreviewSchedule. Show the user the next few run times it returns and fix the wording if the parser refuses it. If the user names a time zone, pass it along; otherwise the machine's zone is used.
3. The target: which folder do the runs work in (default: this session's folder), and should the automation live in this project (scope "project") or be personal (scope "user")?
4. The model and effort: ask only if the user cares; leaving the model out uses the default.
5. How much freedom the runs get: autonomy off, low, medium or high (default high). Because no one is there to approve anything, a run that only reads and reports needs little; a run that edits files or runs commands needs the matching level. Prefer the lowest level that lets the job finish.

Then write the run prompt yourself. It must work with no one to answer questions: state the goal, the steps, where to look, what a good report contains, and what must not be touched. Do not rely on anything said in this conversation, because the run will not see it.

Before creating anything, show the user one summary: name, schedule in plain words with the next run time, folder, scope, model, autonomy and the full run prompt. Ask whether to create it. Only after a clear yes, call CreateAutomation once with the confirmed values. Never call it on a guess, and never call EditAutomation, DeleteAutomation or RunAutomation unless the user asks.

When it is created, say where it was saved, when it will first run, and that it does not run until the daemon is running. Offer a test run with RunAutomation. If the user wants changes after that, use EditAutomation. If something is unclear, ask rather than invent.`;

/**
 * Turns `start_automation_setup` params into `initialize_session` params: the overlay is appended to the system prompt
 * (an explicit `systemPrompt` from the caller is kept in front of it), the session gets the setup tag and a title.
 * `templateId` and `templateParameters` are not part of initialize_session; they become a line of context in the overlay.
 */
export function automationSetupParams(p: Record<string, unknown>): Record<string, unknown> {
  const { templateId, templateParameters, ...rest } = p;
  let overlay = AUTOMATION_SETUP_OVERLAY;
  if (typeof templateId === "string" && templateId) {
    const t = findTemplate(templateId);
    overlay += t
      ? `\n\nThe user already chose the template "${t.id}" (${t.name}). Start from it: confirm its parameters${templateParameters && typeof templateParameters === "object" ? ` (given so far: ${JSON.stringify(templateParameters)})` : ""}, then continue with the schedule and the rest.`
      : `\n\nThe user asked for a template "${templateId}" that does not exist; say so and offer the ones ListAutomationTemplates returns.`;
  }
  const given = rest.systemPrompt;
  const systemPrompt = typeof given === "string" && given.trim()
    ? `${given}\n\n${overlay}` // a caller's own base prompt is kept, the overlay follows it
    : { type: "preset", append: typeof given === "object" && given && typeof (given as { append?: unknown }).append === "string" ? `${(given as { append: string }).append}\n\n${overlay}` : overlay };
  const tags = Array.isArray(rest.tags) ? rest.tags : [];
  return {
    ...rest,
    title: typeof rest.title === "string" && rest.title ? rest.title : "Automation setup",
    systemPrompt,
    tags: [...tags, { name: AUTOMATION_SETUP_TAG }],
  };
}
