export function installRendererCrashCapture(send: (value: { kind: string; detail: string }) => Promise<unknown>) {
  const report = (kind: string, error: unknown) => { let detail: string; try { detail = error instanceof Error ? `${error.name}: ${error.message}\n${error.stack ?? ""}` : String(error); } catch { detail = "Unavailable error detail"; } try { void Promise.resolve(send({ kind, detail: detail.slice(0, 24000) })).catch(() => {}); } catch {} };
  const error = (e: ErrorEvent) => report("uncaughtError", e.error ?? e.message), rejection = (e: PromiseRejectionEvent) => report("unhandledRejection", e.reason);
  window.addEventListener("error", error); window.addEventListener("unhandledrejection", rejection);
  return () => { window.removeEventListener("error", error); window.removeEventListener("unhandledrejection", rejection); };
}
