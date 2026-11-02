// Automation templates (spec 16.8, approved by the owner): ready-made prompts with a schedule and a few fill-in
// parameters. They are plain data; `instantiateTemplate` fills the {{key}} placeholders and returns the pieces
// `create_automation` needs. Every template is read-only by default (it reports, it does not change the project).

export interface TemplateParam {
  key: string;
  label: string;
  description: string;
  /** Used when the caller gives no value. A parameter without a default is required. */
  default?: string;
}

export interface AutomationTemplate {
  id: string;
  name: string;
  description: string;
  category: "health" | "dependencies" | "testing" | "release" | "git";
  /** Schedule text in any form the schedule parser accepts. */
  schedule: string;
  parameters: TemplateParam[];
  /** Run prompt. {{key}} is replaced by the parameter value. */
  instructions: string;
  autonomy: "off" | "low" | "medium" | "high";
}

export const AUTOMATION_TEMPLATES: AutomationTemplate[] = [
  {
    id: "daily-repo-health",
    name: "Daily repo health check",
    description: "Every weekday morning: build, run the tests and the linter, and write a short health report.",
    category: "health",
    schedule: "every weekday at 8am",
    autonomy: "medium",
    parameters: [
      { key: "build_command", label: "Build command", description: "Command that builds the project.", default: "the project's usual build command" },
      { key: "test_command", label: "Test command", description: "Command that runs the tests.", default: "the project's usual test command" },
      { key: "lint_command", label: "Lint command", description: "Command that runs the linter or type checker.", default: "the project's usual lint or type-check command" },
    ],
    instructions: [
      "Check the health of this repository and write a report.",
      "1. Run {{build_command}}, then {{test_command}}, then {{lint_command}}. If a command does not exist, say so and move on.",
      "2. For every failure, quote the first useful error line and name the file it points at.",
      "3. Compare with the previous report in your reports folder, if there is one: say what is new, what got fixed and what is still broken.",
      "4. Do not change any file in the repository. Finish with a verdict of healthy, degraded or broken, and one line on what to look at first.",
    ].join("\n"),
  },
  {
    id: "dependency-update-check",
    name: "Dependency update check",
    description: "Weekly: list outdated dependencies, flag major bumps and known advisories, suggest an update order.",
    category: "dependencies",
    schedule: "every monday at 9am",
    autonomy: "low",
    parameters: [
      { key: "package_manager", label: "Package manager", description: "npm, bun, pnpm, yarn, pip, cargo, go and so on.", default: "the package manager this project uses" },
      { key: "ignore", label: "Packages to ignore", description: "Comma separated names to leave out of the report.", default: "none" },
    ],
    instructions: [
      "Look for outdated dependencies in this repository using {{package_manager}}.",
      "1. List each outdated package with its current, wanted and latest version. Skip these packages: {{ignore}}.",
      "2. Mark major version jumps separately and read the changelog or release notes if they are available locally. Do not use the network for anything but the package manager's own query.",
      "3. Report any security advisory the package manager already knows about.",
      "4. Propose an update order: safe patch and minor bumps first, then majors one at a time, each with the risk in a sentence.",
      "Do not edit manifests or lock files. Write the result as a report.",
    ].join("\n"),
  },
  {
    id: "flaky-test-triage",
    name: "Flaky test triage",
    description: "Nightly: rerun the test suite several times, find tests that pass and fail inconsistently, and rank them.",
    category: "testing",
    schedule: "daily at 2am",
    autonomy: "medium",
    parameters: [
      { key: "test_command", label: "Test command", description: "Command that runs the tests.", default: "the project's usual test command" },
      { key: "repeats", label: "Repeats", description: "How many times to run the suite.", default: "5" },
    ],
    instructions: [
      "Find flaky tests in this repository.",
      "1. Run {{test_command}} {{repeats}} times, noting the result of every test in every run. Keep the runs sequential.",
      "2. A test is flaky when it passes in some runs and fails in others. List each one with its pass count, and the error from a failing run.",
      "3. For each flaky test, read it and the code it touches, and give the most likely cause (timing, shared state, order dependence, network, randomness) with the evidence.",
      "4. Keep a running list in your memory folder so repeat offenders from earlier runs are marked. Do not modify the tests or the code.",
    ].join("\n"),
  },
  {
    id: "changelog-draft",
    name: "Changelog draft",
    description: "Weekly: turn the commits since the last tag or last report into a grouped changelog draft.",
    category: "release",
    schedule: "every friday at 4pm",
    autonomy: "low",
    parameters: [
      { key: "base_ref", label: "Base reference", description: "Tag or branch to compare against.", default: "the latest tag" },
      { key: "audience", label: "Audience", description: "Who reads the changelog.", default: "users of the project" },
    ],
    instructions: [
      "Draft a changelog entry for this repository, written for {{audience}}.",
      "1. Read the git history since {{base_ref}} (with no tag, since the date of your previous run noted in your memory folder).",
      "2. Group the changes under Added, Changed, Fixed and Removed. Merge commits that belong together and drop pure noise such as formatting or dependency churn.",
      "3. Write each item as one plain sentence about the effect, not the implementation. Mention breaking changes first, in their own section.",
      "4. Save the draft as a markdown file in your reports folder and note in memory how far you got, so the next run starts from there. Do not edit CHANGELOG files in the repository.",
    ].join("\n"),
  },
  {
    id: "stale-branch-report",
    name: "Stale branch report",
    description: "Weekly: list branches with no recent commits, whether they are merged, and who last touched them.",
    category: "git",
    schedule: "every monday at 10am",
    autonomy: "low",
    parameters: [
      { key: "stale_days", label: "Days without a commit", description: "A branch is stale after this many days.", default: "30" },
      { key: "main_branch", label: "Main branch", description: "Branch that merged work lands on.", default: "main" },
    ],
    instructions: [
      "Report on stale branches in this repository, using only local git commands.",
      "1. List local and remote-tracking branches whose last commit is older than {{stale_days}} days.",
      "2. For each, say whether it is fully merged into {{main_branch}}, how many commits it is ahead and behind, the last author and the date.",
      "3. Split the list into: safe to delete (merged), probably abandoned (old and unmerged), and worth a look (unmerged with substantial work).",
      "4. Print the delete commands for the first group but never run them. Do not fetch, push or delete anything.",
    ].join("\n"),
  },
  {
    id: "todo-digest",
    name: "TODO and FIXME digest",
    description: "Weekly: collect TODO and FIXME comments, show what is new since last week and what has been open longest.",
    category: "health",
    schedule: "every friday at 11am",
    autonomy: "low",
    parameters: [
      { key: "markers", label: "Markers", description: "Comment markers to look for.", default: "TODO, FIXME, HACK" },
      { key: "paths", label: "Paths", description: "Where to look.", default: "the whole repository, skipping vendored and generated folders" },
    ],
    instructions: [
      "Build a digest of work-in-progress markers in this repository.",
      "1. Search {{paths}} for these markers: {{markers}}.",
      "2. Group the hits by folder. Use git blame on a sample to find how old the oldest ones are.",
      "3. Compare with the list saved in your memory folder: show new markers, removed markers and the ten oldest. Save the current list there afterwards.",
      "4. End with the three markers that look most worth doing now and why. Do not edit the code.",
    ].join("\n"),
  },
];

export class TemplateError extends Error {}

export const findTemplate = (id: string) => AUTOMATION_TEMPLATES.find((t) => t.id === id);

/** Copies of the templates, so a caller cannot change the data. */
export function listTemplates(): AutomationTemplate[] {
  return AUTOMATION_TEMPLATES.map((t) => ({ ...t, parameters: t.parameters.map((p) => ({ ...p })) }));
}

export interface TemplateInstance {
  templateId: string;
  name: string;
  description: string;
  schedule: string;
  instructions: string;
  autonomy: AutomationTemplate["autonomy"];
  tags: string[];
}

/**
 * Fills a template. Unknown parameter keys and blank required values are errors. Values are substituted verbatim and
 * only once, so a value that contains `{{other}}` is not expanded.
 */
export function instantiateTemplate(id: string, values: Record<string, unknown> = {}): TemplateInstance {
  const t = findTemplate(id);
  if (!t) throw new TemplateError(`Unknown template: ${id}. Known templates: ${AUTOMATION_TEMPLATES.map((x) => x.id).join(", ")}`);
  const known = new Set(t.parameters.map((p) => p.key));
  for (const k of Object.keys(values)) if (!known.has(k)) throw new TemplateError(`Template ${id} has no parameter "${k}". Parameters: ${[...known].join(", ") || "none"}`);
  const filled: Record<string, string> = {};
  for (const p of t.parameters) {
    const v = values[p.key];
    const text = v === undefined || v === null ? "" : String(v).trim();
    if (text) filled[p.key] = text;
    else if (p.default !== undefined) filled[p.key] = p.default;
    else throw new TemplateError(`Parameter "${p.key}" (${p.label}) is required for template ${id}`);
  }
  const instructions = t.instructions.replace(/\{\{(\w+)\}\}/g, (_, k: string) => filled[k] ?? "");
  return { templateId: t.id, name: t.name, description: t.description, schedule: t.schedule, instructions, autonomy: t.autonomy, tags: ["template", t.id] };
}
