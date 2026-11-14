const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { spawnSync } = require('node:child_process');
const load = file => import(pathToFileURL(path.resolve(file)).href);
const cli = (args = [], input = '') => spawnSync(process.execPath, ['cli.js', ...args], { cwd: process.cwd(), encoding: 'utf8', input, timeout: 5000 });
(async () => {
const m = await load('lib.js');
assert(m.compareVersion('1.10','1.2')>0);assert.equal(m.compareVersion('2','2.0.0'),0);assert(m.compareVersion('9007199254740993','9007199254740992')>0);assert.throws(()=>m.compareVersion('1.x','2'));
console.log('PASS');
})().catch(error => { console.error(error.message); process.exitCode = 1; });
