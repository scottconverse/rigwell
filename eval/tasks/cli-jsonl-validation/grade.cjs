const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { spawnSync } = require('node:child_process');
const load = file => import(pathToFileURL(path.resolve(file)).href);
const cli = (args = [], input = '') => spawnSync(process.execPath, ['cli.js', ...args], { cwd: process.cwd(), encoding: 'utf8', input, timeout: 5000 });
(async () => {
const r=cli([], '{"active":true,"x":1}\r\n\n{"active":false}\n{"active":true,"x":2}');assert.equal(r.status,0);assert.equal(r.stdout,'{"active":true,"x":1}\n{"active":true,"x":2}\n');const bad=cli([],'{bad');assert.equal(bad.status,2);assert(bad.stderr.trim());
console.log('PASS');
})().catch(error => { console.error(error.message); process.exitCode = 1; });
