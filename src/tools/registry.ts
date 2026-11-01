import type { AutonomyLevel, Tool } from "../core/types.ts";
import { createCreateTool } from "./create.ts";
import { createEditTool } from "./edit.ts";
import { createExecuteTool } from "./execute.ts";
import { createGlobTool } from "./glob.ts";
import { createGrepTool } from "./grep.ts";
import { createReadTool } from "./read.ts";

/** Read, Execute, Grep, Glob, Edit, Create. */
export function createCoreTools(opts: { skipPermissions?: boolean } = {}): Tool[] {
  return [
    createReadTool(),
    createExecuteTool({ skipPermissions: opts.skipPermissions }),
    createGrepTool(),
    createGlobTool(),
    createEditTool(),
    createCreateTool(),
  ];
}

/**
 * Tools sent to the model for a session. Edit and Create are left out when the
 * session is read-only (autonomy off, permissions not skipped); with skipPermissions
 * Execute loses riskLevel/riskReason.
 */
export function toolsForSession(opts: { autonomy: AutonomyLevel; skipPermissions: boolean }): Tool[] {
  const readOnly = opts.autonomy === "off" && !opts.skipPermissions;
  return createCoreTools({ skipPermissions: opts.skipPermissions }).filter(
    (t) => !(readOnly && (t.name === "Edit" || t.name === "Create")),
  );
}
