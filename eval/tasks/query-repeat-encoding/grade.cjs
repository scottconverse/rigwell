const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { spawnSync } = require('node:child_process');
const load = file => import(pathToFileURL(path.resolve(file)).href);
const cli = (args = [], input = '') => spawnSync(process.execPath, ['cli.js', ...args], { cwd: process.cwd(), encoding: 'utf8', input, timeout: 5000 });
(async () => {
const m = await load('lib.js');
const q=m.parseQuery('?x=a+b&x=c%3Dd&empty&__proto__=safe');assert.deepEqual(q.x,['a b','c=d']);assert.equal(q.empty,'');assert.equal(q.__proto__,'safe');assert.equal(Object.keys(m.parseQuery('')).length,0);assert.throws(()=>m.parseQuery('x=%ZZ'));
console.log('PASS');
})().catch(error => { console.error(error.message); process.exitCode = 1; });
