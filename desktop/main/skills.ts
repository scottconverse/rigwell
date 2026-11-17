// Skills for the composer's Skills dialog (spec §5.8, §14.3). The daemon has no "list skills" method, so the main process
// scans the same folders the agent uses, through the shared registry.
import { SkillRegistry, type Skill } from "../../src/skills/skills.ts";

export interface SkillView { name: string; description: string; bucket: string; status: string; filePath: string; body: string; errors: string[]; userInvocable: boolean }

export function listSkillViews(cwd: string): SkillView[] {
  const reg = new SkillRegistry({ cwd }).load();
  return reg.all.map((s: Skill) => ({
    name: s.name || s.rawName || "(unnamed)", description: s.description, bucket: s.bucket, status: s.status, filePath: s.filePath,
    body: s.body, errors: s.errors, userInvocable: s.userInvocable,
  }));
}
