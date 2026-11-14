const { pathToFileURL } = require("node:url");
const { join } = require("node:path");
import(pathToFileURL(join(process.cwd(), "greet.js")).href).then((m) => {
  const got = m.greet("Ada");
  if (got !== "Hello, Ada!") { console.log("FAIL greet gave " + JSON.stringify(got)); process.exit(1); }
  console.log("PASS");
}).catch((e) => { console.log("FAIL " + e.message); process.exit(1); });
