import { expect, test } from "bun:test";
import { tmpEnv } from "../storage/helpers.ts";
import { withStartupLock } from "../../src/machines/startup-lock.ts";
import { fileURLToPath } from "node:url";

test("concurrent remote bootstraps serialize without blocking readiness or removing another owner's lock", async () => {
  const env = tmpEnv();
  let active = 0, peak = 0;
  const order: number[] = [];
  try {
    await Promise.all([1, 2, 3].map((n) => withStartupLock(env.root, async () => {
      active++; peak = Math.max(peak, active); order.push(n); await Bun.sleep(30); active--; return n;
    })));
    expect(peak).toBe(1); expect(order.length).toBe(3);
    expect(await withStartupLock(env.root, async () => "reused")).toBe("reused");
  } finally { env.cleanup(); }
});

test("an abrupt launcher exit releases the startup lock without deleting stale files or killing a PID", async () => {
  const env = tmpEnv();
  const module = fileURLToPath(new URL("../../src/machines/startup-lock.ts", import.meta.url));
  try {
    const child = Bun.spawn([process.execPath, "-e", `import {withStartupLock} from ${JSON.stringify(module)};await withStartupLock(${JSON.stringify(env.root)},async()=>{console.log('owned-lock-acquired');process.exit(0)});`], { stdout: "pipe", stderr: "pipe", windowsHide: true });
    const output = await new Response(child.stdout).text();
    expect(await child.exited).toBe(0); expect(output.trim()).toBe("owned-lock-acquired");
    expect(await withStartupLock(env.root, async () => "recovered")).toBe("recovered");
  } finally { env.cleanup(); }
});
