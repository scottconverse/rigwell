// Loaded before every test file (bunfig.toml). Tests run with the working folders they create trusted (spec 12.2
// trustedFolders; RIGWELL_TRUST_CWD) and without the automatic title request, which would add a model call to every
// scripted fake. Tests that cover trust or titles clear these variables themselves.
process.env.RIGWELL_TRUST_CWD = "1";
process.env.RIGWELL_NO_AUTO_TITLE = "1";
// No test reaches the real GitHub: `gh` is turned off unless a test points RIGWELL_GH_CMD at a fake one.
process.env.RIGWELL_GH_CMD = "[]";
