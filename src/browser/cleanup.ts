import { rm } from "node:fs/promises";

/** Bun does not retry Windows recursive-removal locks through rm's retry options. */
export async function removeBrowserProfile(target: string, remove: typeof rm = rm) {
  for (let attempt = 0; ; attempt++) {
    try { await remove(target, { recursive: true, force: true }); return; }
    catch (error) {
      if (attempt === 4 || !["EBUSY", "EMFILE", "ENFILE", "ENOTEMPTY", "EPERM"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
      // Preserve the existing four retries and 25 ms linear backoff, without blocking the event loop.
      await Bun.sleep(25 * (attempt + 1));
    }
  }
}
