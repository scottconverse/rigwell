/** Stop waiting without retaining an abort listener after the operation settles. */
export async function abortable<T>(pending: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return pending;
  signal.throwIfAborted();
  let cancel!: () => void;
  try {
    return await Promise.race([pending, new Promise<never>((_resolve, reject) => {
      cancel = () => reject(new Error("Operation cancelled"));
      signal.addEventListener("abort", cancel, { once: true });
      if (signal.aborted) cancel();
    })]);
  } finally { signal.removeEventListener("abort", cancel); }
}
