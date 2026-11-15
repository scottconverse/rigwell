import { realpathSync } from 'node:fs';

// NSIS and the runner can spell the same installed file through different
// junctions or short paths. Compare existing file identities after resolution.
export function verifyProtocolRegistration(registration: {protocol: unknown; command: unknown}, executable: string) {
  const match = typeof registration.command === 'string' ? /^"([^"]+)"\s+.*"%1"(?:\s|$)/.exec(registration.command) : null;
  if (registration.protocol === null || !match) throw new Error(`Invalid installed protocol registration: ${JSON.stringify(registration)}`);
  const actual = realpathSync.native(match[1]!).toLowerCase();
  const expected = realpathSync.native(executable).toLowerCase();
  if (actual !== expected) throw new Error(`Installed protocol executable mismatch: registered=${actual}; installed=${expected}; command=${registration.command}`);
}
