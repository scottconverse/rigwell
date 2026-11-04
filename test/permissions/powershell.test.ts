import { describe, expect, test } from "bun:test";
import { classifyCommand, parsePowershell } from "../../src/permissions/command.ts";
import { defaultCommandLists } from "../../src/permissions/lists.ts";

const lists = defaultCommandLists();

describe("powershell -Command parsing (spec 5.5.3)", () => {
  test("extracts the body", () => {
    expect(parsePowershell('powershell -Command "git status"')).toEqual({ kind: "body", body: "git status" });
    expect(parsePowershell("pwsh.exe -c 'ls'")).toEqual({ kind: "body", body: "ls" });
    expect(parsePowershell("git status")).toBeNull();
  });
  test("an allowlisted body is auto-allowed", () => {
    expect(classifyCommand('powershell -Command "git status"', lists).kind).toBe("allow");
    expect(classifyCommand('powershell -NoProfile -Command "git status; git diff"', lists).kind).toBe("allow");
  });
  test("a body with one non-allowlisted part is not allowed", () => {
    expect(classifyCommand('powershell -Command "git status; npm publish"', lists).kind).toBe("none");
  });
  test("deny and block entries are found inside the body", () => {
    expect(classifyCommand('powershell -Command "echo hi; shutdown"', lists).kind).toBe("ask");
    const l = { ...lists, block: ["npm publish"] };
    expect(classifyCommand('powershell -Command "npm publish"', l).kind).toBe("block");
  });
  test("-EncodedCommand is never auto-allowed", () => {
    expect(parsePowershell("powershell -EncodedCommand ZwBpAHQA")).toEqual({ kind: "encoded" });
    expect(classifyCommand("powershell -enc ZwBpAHQA", lists).kind).toBe("none");
    expect(classifyCommand("powershell -EncodedCommand ZwBpAHQA", { ...lists, allow: [...lists.allow, "powershell"] }).kind).toBe("none");
  });
});
