const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { spawnSync } = require('node:child_process');
const load = file => import(pathToFileURL(path.resolve(file)).href);
const cli = (args = [], input = '') => spawnSync(process.execPath, ['cli.js', ...args], { cwd: process.cwd(), encoding: 'utf8', input, timeout: 5000 });
(async () => {
const m = await load('lib.js');
assert.equal(m.canonicalKey({z:1,a:{b:2,a:[3,1]}}),' {"a":{"a":[3,1],"b":2},"z":1}'.trim());const x={a:1};assert.equal(m.canonicalKey([x,x]),'[{"a":1},{"a":1}]');x.x=x;assert.throws(()=>m.canonicalKey(x));for(const v of [undefined,Infinity,()=>0])assert.throws(()=>m.canonicalKey(v));
console.log('PASS');
})().catch(error => { console.error(error.message); process.exitCode = 1; });
