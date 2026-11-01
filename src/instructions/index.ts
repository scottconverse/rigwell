// Instruction files, CLAUDE.md / AGENTS.md (spec §12.2). Standalone; the lead wires it in.
//
// Integration:
//   - Session start: `const instr = new InstructionLoader({cwd}); const {block} = instr.load();`. When `block` is non-null,
//     put it in the first-message context blocks (prompts.md §4.2, after the environment block and before skills, no cache
//     breakpoint). contextBlocks() in src/agent/prompts.ts currently omits it.
//   - After Read / Create / Edit succeed on a path: `instr.discoverForPath(path)`; if `instr.hasPending()`, append
//     `instr.takePending()` as a reminder message at the start of the NEXT turn (append-only, never edit earlier blocks).
//   - After compaction: `instr.afterCompaction()`; the session-start block is re-sent by the compaction preamble logic.
//   - Header counts (UI): `instr.loadedCount()`.
export * from "./instructions.ts";
