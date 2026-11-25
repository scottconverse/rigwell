// CI workflows tab: the ready-made jobs shown in the templates dialog. Pure data, no React.
import { homeRoute } from "./workstream-templates.ts";

export interface CiWorkflow { name: string; description: string; draft: string }

export const CI_INTRO = "Workflows that watch your repository and run the agent on this computer. Choosing one starts a session with the setup message filled in. Nothing is installed until you approve it.";

export const CI_WORKFLOWS: CiWorkflow[] = [
  { name: "Pull Request Review", description: "Check pull requests in your repositories.",
    draft: "Set up Pull Request Review for this repository. Use the install-code-review skill to review new and updated pull requests. Keep the reports local unless I say otherwise." },
  { name: "QA Checks", description: "Create and run quality checks for your changes.",
    draft: "Set up QA Checks for this repository. Use the install-qa skill to test the changed browser flows on new and updated pull requests." },
  { name: "Docs Refresh", description: "Keep the project wiki up to date after each new commit.",
    draft: "Set up Docs Refresh for this repository. Use the install-wiki skill to refresh the project wiki after new commits." },
  { name: "Security Sweep", description: "Run a thorough security review of the whole repository on a timetable.",
    draft: "Set up Security Sweep for this repository. Create a scheduled automation that runs every Monday at 6am and uses the deep-security-review skill. Save the report locally. Do not post it anywhere." },
];

/** Home route for a workflow card. With no folder, only the draft is passed so Home keeps its own default folder. */
export function workflowRoute(folder: string | undefined, draft: string): string {
  return folder ? homeRoute(folder, draft) : `/?draft=${encodeURIComponent(draft)}`;
}
