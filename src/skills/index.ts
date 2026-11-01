// Skills (spec §5.8). Standalone; the lead wires it into the loop.
//
// Integration:
//   - Session start: `const skills = new SkillRegistry({cwd}).load()`. Context block: `skills.contextBlock(modelContextWindow)`
//     returns the prompts.md §4.3 `<skills>` text (null => omit the block, and then also omit the Skill tool:
//     `skills.skillToolAvailable()`). contextBlocks() in src/agent/prompts.ts should push it as the cache-breakpoint block.
//   - Skill tool (direct mode and Script binding `tools.Skill`): `runSkill(skills, {name, args})` => {name, instructions}.
//     Direct mode: tool_result text = `instructions`. Script: return the object. SkillError => tool_result isError with
//     `error.message`. Read-only, no confirmation, allowed in spec/read-only mode. Tool schema/description come from
//     PROMPT_TEXT.tool_Skill_desc / tool_Skill_schema.
//   - Slash command `/name` (user-invocable skills): `skills.get(name)` where `userInvocable`.
//   - After Read/Create/Edit touches a path: `const added = skills.discoverForPath(path)`; if non-empty, append
//     `renderAdditionalSkills(added)` as a reminder message next turn and call `skills.markAnnounced(added)`.
//     After compaction call `skills.afterCompaction()` (announced skills are then part of the main list on the next render).
//   - `disabledSkills` is read from settings automatically; pass `includeBuiltins:false` to drop built-ins.
export * from "./skills.ts";
