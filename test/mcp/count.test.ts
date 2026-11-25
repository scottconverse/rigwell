import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { mcpCountMethods } from "../../src/mcp/config.ts";
import { tmpEnv, writeJson } from "../storage/helpers.ts";

describe("count_mcp_servers", () => {
  test("no mcp.json counts 0", () => {
    const env = tmpEnv();
    try {
      expect(mcpCountMethods.count_mcp_servers().count).toBe(0);
    } finally { env.cleanup(); }
  });

  test("counts only enabled user-level servers", () => {
    const env = tmpEnv();
    try {
      writeJson(join(env.rigwellHome, "mcp.json"), {
        mcpServers: {
          a: { command: "bun", args: ["--version"] },
          b: { command: "bun", disabled: true },
        },
      });
      expect(mcpCountMethods.count_mcp_servers().count).toBe(1);
    } finally { env.cleanup(); }
  });
});
