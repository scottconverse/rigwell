const { pathToFileURL } = require("node:url");
const { join } = require("node:path");
import(pathToFileURL(join(process.cwd(), "util.js")).href).then((m) => {
  const cases = [[5, 0, 10, 5], [-3, 0, 10, 0], [99, 0, 10, 10], [0, 0, 10, 0], [10, 0, 10, 10]];
  if (typeof m.clamp !== "function") { console.log("FAIL clamp is not exported"); process.exit(1); }
  if (m.double(4) !== 8) { console.log("FAIL double was broken"); process.exit(1); }
  for (const [n, lo, hi, want] of cases) {
    if (m.clamp(n, lo, hi) !== want) { console.log(`FAIL clamp(${n},${lo},${hi}) gave ${m.clamp(n, lo, hi)}`); process.exit(1); }
  }
  console.log("PASS");
}).catch((e) => { console.log("FAIL " + e.message); process.exit(1); });
