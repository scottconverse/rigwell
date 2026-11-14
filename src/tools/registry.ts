import type { AutonomyLevel, Tool } from "../core/types.ts";
import { agentBrowserTools, defaultAgentBrowsers } from "../browser/tools.ts";
import { createApplyPatchTool } from "./apply-patch.ts";
import { createCreateTool } from "./create.ts";
import { createEditTool } from "./edit.ts";
import { createExecuteTool } from "./execute.ts";
import { createFetchUrlTool } from "./fetch-url.ts";
import { createGlobTool } from "./glob.ts";
import { createGrepTool } from "./grep.ts";
import { createLsTool } from "./ls.ts";
import { createReadTool } from "./read.ts";

export type FileEditProfile = "apply-patch" | "create-edit";

/** Read, LS, Execute, Grep, Glob, FetchUrl and the file-edit tools of the profile (Edit and Create, or ApplyPatch). */
export function createCoreTools(opts: { skipPermissions?: boolean; fileEditProfile?: FileEditProfile } = {}): Tool[] {
  return [
    createReadTool(),
    createLsTool(),
    createExecuteTool({ skipPermissions: opts.skipPermissions }),
    createGrepTool(),
    createGlobTool(),
    createFetchUrlTool(),
    ...agentBrowserTools(defaultAgentBrowsers),
    ...(opts.fileEditProfile === "apply-patch" ? [createApplyPatchTool()] : [createEditTool(), createCreateTool()]),
  ];
}

const EDIT_TOOLS = ["Edit", "Create", "ApplyPatch"];

/**
 * Tools sent to the model for a session. Edit, Create and ApplyPatch are left out when the session is read-only
 * (autonomy off, permissions not skipped); with skipPermissions Execute loses riskLevel/riskReason. `extraIds`
 * adds known tools the profile left out (settings enabledToolIds / additionalToolIds).
 */
export function toolsForSession(opts: {
  autonomy: AutonomyLevel; skipPermissions: boolean; specMode?: boolean; fileEditProfile?: FileEditProfile; extraIds?: string[];
}): Tool[] {
  // Spec mode keeps Edit and Create: plan files under .rigwell/specs/ are written with them.
  const readOnly = opts.autonomy === "off" && !opts.skipPermissions && !opts.specMode;
  const base = createCoreTools({ skipPermissions: opts.skipPermissions, fileEditProfile: opts.fileEditProfile });
  const have = new Set(base.map((t) => t.name));
  const more = opts.extraIds?.length
    ? [...createCoreTools({ skipPermissions: opts.skipPermissions, fileEditProfile: "create-edit" }), createApplyPatchTool()]
        .filter((t) => opts.extraIds!.includes(t.name) && !have.has(t.name))
    : [];
  return [...base, ...more].filter((t) => !(readOnly && EDIT_TOOLS.includes(t.name)));
}
