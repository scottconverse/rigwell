---
name: security-review
description: Review a change or a code area for security vulnerabilities such as injection, broken access control, unsafe deserialization and leaked secrets.
---
# Security review

Look for exploitable weaknesses in the code the user names, or in the current diff when none is named. Favor a short list of real issues over a long list of theoretical ones.

## Method

1. **Map the entry points**: HTTP handlers, CLI arguments, file and message readers, webhooks, background job inputs. Anything an outside party can influence is untrusted.
2. **Follow untrusted data** from each entry point to where it is used. Check every sink on the way:
   - shell or process execution (command injection, argument injection)
   - database queries (SQL or NoSQL injection)
   - file paths (traversal, symlink following, writes outside the intended root)
   - HTML, templates and logs (cross-site scripting, log forging)
   - deserialization, `eval`, dynamic imports, regular expressions with catastrophic backtracking
   - outbound requests built from user input (SSRF)
3. **Check access control**: every sensitive action should verify who is asking and whether they may do it, on the server side, for the specific object. Look for missing checks, checks only in the UI, and identifiers that can be guessed.
4. **Check secrets and crypto**: keys or tokens in source, config, test fixtures or logs; weak hashing for passwords; home-made crypto; predictable random values used for security; disabled TLS verification.
5. **Check dependencies and config**: known-bad versions in lockfiles when you can verify them, debug modes, permissive CORS, default credentials.

## Report

For each finding give: severity (critical, high, medium, low), location (`file:line`), a one-sentence description of how it could be exploited, and a concrete fix. Say how confident you are and what you did to confirm it.

Do not run exploits against anything outside the local checkout. Do not print secrets you find; refer to them by location. Do not edit files unless asked.
