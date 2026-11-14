import { Database } from "bun:sqlite";
import { lstatSync } from "node:fs";
import { join } from "node:path";
import { makePrivate } from "../platform/private.ts";

/** SQLite's OS lock is released on process death, including an ungraceful Windows exit. */
export async function withStartupLock<T>(root: string, start: () => Promise<T>, timeoutMs = 10_000): Promise<T> {
  const file = join(root, "daemon-start.sqlite");
  for (const suffix of ["", "-journal", "-wal", "-shm"]) {
    try { if (lstatSync(file + suffix).isSymbolicLink()) throw new Error("Remote startup lock must not be linked"); }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
  }
  const db = new Database(file, { create: true, strict: true });
  let locked = false;
  try {
    if (!makePrivate(file)) throw new Error("Remote startup lock must be private");
    db.exec("PRAGMA busy_timeout=0");
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      try { db.exec("BEGIN IMMEDIATE"); locked = true; break; }
      catch (e) {
        if ((e as { errno?: number }).errno !== 5 && !/database is locked/i.test((e as Error).message)) throw e;
        if (Date.now() >= deadline) throw new Error("Another bootstrap is still starting this remote build");
        // Yield so same-process callers can finish readiness and release their transaction too.
        await Bun.sleep(25);
      }
    }
    return await start();
  } finally { try { if (locked) db.exec("ROLLBACK"); } finally { db.close(); } }
}
