const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { spawnSync } = require('node:child_process');
const load = file => import(pathToFileURL(path.resolve(file)).href);
const cli = (args = [], input = '') => spawnSync(process.execPath, ['cli.js', ...args], { cwd: process.cwd(), encoding: 'utf8', input, timeout: 5000 });
(async () => {
const m = await load('lib.js');
assert.deepEqual(m.createUser('Ada'),{id:1,displayName:'Ada'});assert.deepEqual(m.createUser('Bo'),{id:2,displayName:'Bo'});assert.equal(m.formatUser(2),'2: Bo');assert.deepEqual(m.getUser(1),{id:1,displayName:'Ada'});assert.throws(()=>m.getUser(99));for(const p of ['lib.js','store.js'])assert(!/\.name\b/.test(fs.readFileSync(p,'utf8')));
console.log('PASS');
})().catch(error => { console.error(error.message); process.exitCode = 1; });
