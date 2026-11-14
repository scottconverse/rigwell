// Loaded before every test file (bunfig.toml). Tests run with the working folders they create trusted (spec 12.2
// trustedFolders; RIGWELL_TRUST_CWD) and without the automatic title request, which would add a model call to every
// scripted fake. Tests that cover trust or titles clear these variables themselves.
import { mkdtempSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

// Personal instructions, skills and credentials must never enter fixture sessions.
// Keep the browser install cache visible after isolating the personal home.
const browserCache = process.platform === "win32" ? process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local")
  : process.platform === "darwin" ? join(homedir(), "Library", "Caches")
  : process.env.XDG_CACHE_HOME || join(homedir(), ".cache");
process.env.PLAYWRIGHT_BROWSERS_PATH ??= join(browserCache, "ms-playwright");
const testUserHome = mkdtempSync(join(tmpdir(), "rigwell-test-user-home-"));
process.env.HOME = testUserHome;
process.env.USERPROFILE = testUserHome;
process.env.RIGWELL_HOME = join(testUserHome, ".rigwell");
process.env.RIGWELL_TRUST_CWD = "1";
process.env.RIGWELL_NO_AUTO_TITLE = "1";
