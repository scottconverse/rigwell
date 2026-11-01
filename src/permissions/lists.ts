import type { CommandLists } from "../core/types.ts";

/** Built-in safeguard ids (spec 5.5.3). */
export const SAFEGUARD_IDS = [
  "rm-protected-target",
  "filesystem-format",
  "system-power",
  "init-runlevel",
  "dd-zero-device-write",
  "dd-device-write",
  "chmod-recursive-mode",
  "chown-recursive",
  "windows-format",
  "powershell-force-delete",
  "fork-bomb",
] as const;
export type SafeguardId = (typeof SAFEGUARD_IDS)[number];

/** Token-list safeguards. The rm safeguard is structural (see command.ts). */
export const SAFEGUARDS: { id: SafeguardId; entries: string[] }[] = [
  { id: "filesystem-format", entries: ["mkfs", "mkfs.ext4", "mkfs.ext3", "mkfs.vfat", "mkfs.ntfs"] },
  { id: "dd-zero-device-write", entries: ["dd if=/dev/zero of=/dev"] },
  { id: "dd-device-write", entries: ["dd of=/dev"] },
  { id: "system-power", entries: ["shutdown", "reboot", "halt", "poweroff"] },
  { id: "init-runlevel", entries: ["init 0", "init 6"] },
  { id: "chmod-recursive-mode", entries: ["chmod -R 777 /", "chmod -R 000 /"] },
  { id: "chown-recursive", entries: ["chown -R"] },
  { id: "windows-format", entries: ["Format-Volume", "format.com"] },
  { id: "powershell-force-delete", entries: ["powershell Remove-Item -Recurse -Force"] },
];

/** Targets that make `rm -r` / `rm -rf` a protected-target delete. */
export const RM_PROTECTED_TARGETS = ["/", "/*", ".", "./", "..", "~", "~/", "~/*", "$HOME", "${HOME}", "$HOME/*", "${HOME}/*"];

/** Fork-bomb spellings, compared with whitespace removed. */
export const FORK_BOMBS = [":(){:|:&};:", ":(){:|:&};"];

export const DEFAULT_ALLOW = ["ls", "pwd", "dir", "git status", "git diff", "git log", "git show", "git blame", "git ls-files"];

const safeguardDeny = SAFEGUARDS.flatMap((s) => s.entries);

/** The default lists as settings data. rm -r on protected targets is covered by the rm-protected-target safeguard. */
export const DEFAULT_COMMAND_LISTS: CommandLists = {
  allow: [...DEFAULT_ALLOW],
  deny: [...safeguardDeny],
  block: [],
};

export function defaultCommandLists(): CommandLists {
  return { allow: [...DEFAULT_COMMAND_LISTS.allow], deny: [...DEFAULT_COMMAND_LISTS.deny], block: [] };
}

/** Built-in allow rules: ids and token prefixes. */
export const BUILTIN_ALLOW_RULES: { id: string; prefixes: string[][]; caseSensitive: boolean }[] = [
  { id: "builtin/directory-list-allow", prefixes: [["ls"], ["dir"]], caseSensitive: true },
  { id: "builtin/pwd-allow", prefixes: [["pwd"]], caseSensitive: true },
  {
    id: "builtin/git-inspection-allow",
    prefixes: ["status", "diff", "log", "show", "blame", "ls-files"].map((s) => ["git", s]),
    caseSensitive: true,
  },
];

/** Segments whose first word is one of these are ignored by the allow check. */
export const IGNORED_FOR_ALLOW = ["head", "tail", "grep", "cat", "echo"];
