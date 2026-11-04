const fs = require("node:fs");
const { execFileSync } = require("node:child_process");
for (const f of fs.readdirSync(".").filter((n) => n.endsWith(".js"))) {
  if (fs.readFileSync(f, "utf8").includes("MAX_RETRY")) { console.log("FAIL MAX_RETRY still in " + f); process.exit(1); }
}
if (!fs.readFileSync("config.js", "utf8").includes("MAX_ATTEMPTS")) { console.log("FAIL MAX_ATTEMPTS not defined"); process.exit(1); }
const out = execFileSync("node", ["main.js"], { encoding: "utf8" }).trim();
if (out !== "ok 3") { console.log("FAIL main.js printed " + out); process.exit(1); }
console.log("PASS");
