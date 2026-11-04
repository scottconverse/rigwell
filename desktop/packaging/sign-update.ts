// Release signing helper for the Linux update check (desktop/main/update-verify.ts).
//   bun desktop/packaging/sign-update.ts keygen <dir>            writes <dir>/update-private.pem (keep secret) and prints the public key
//   bun desktop/packaging/sign-update.ts sign <private.pem> <file>   writes <file>.sig (base64 Ed25519 signature of the file bytes)
// The printed public key (base64 of the 32 raw bytes) is what goes into the app's updatePublicKey setting.
import { createPrivateKey, generateKeyPairSync, sign } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const [cmd, a, b] = process.argv.slice(2);
if (cmd === "keygen" && a) {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  mkdirSync(a, { recursive: true });
  writeFileSync(join(a, "update-private.pem"), privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 });
  const raw = (publicKey.export({ type: "spki", format: "der" }) as Buffer).subarray(-32);
  console.log(`public key (updatePublicKey): ${raw.toString("base64")}`);
} else if (cmd === "sign" && a && b) {
  const sig = sign(null, readFileSync(b), createPrivateKey(readFileSync(a)));
  writeFileSync(b + ".sig", sig.toString("base64") + "\n");
  console.log(`wrote ${b}.sig`);
} else {
  console.error("usage: sign-update.ts keygen <dir> | sign <private.pem> <file>");
  process.exit(2);
}
