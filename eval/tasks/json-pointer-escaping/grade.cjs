const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { spawnSync } = require('node:child_process');
const load = file => import(pathToFileURL(path.resolve(file)).href);
const cli = (args = [], input = '') => spawnSync(process.execPath, ['cli.js', ...args], { cwd: process.cwd(), encoding: 'utf8', input, timeout: 5000 });
(async () => {
const m = await load('lib.js');
const d={'a/b':{'~key':[9]}};assert.equal(m.getPointer(d,''),d);assert.equal(m.getPointer(d,'/a~1b/~0key/0'),9);assert.equal(m.getPointer({},'/toString'),undefined);assert.equal(m.getPointer({},'/x/y'),undefined);assert.throws(()=>m.getPointer(d,'x'));assert.throws(()=>m.getPointer(d,'/~2'));
console.log('PASS');
})().catch(error => { console.error(error.message); process.exitCode = 1; });
