const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { spawnSync } = require('node:child_process');
const load = file => import(pathToFileURL(path.resolve(file)).href);
const cli = (args = [], input = '') => spawnSync(process.execPath, ['cli.js', ...args], { cwd: process.cwd(), encoding: 'utf8', input, timeout: 5000 });
(async () => {
const m = await load('lib.js');
assert.deepEqual(m.topologicalSort({app:['api','db'],api:['db'],other:[]}),['db','api','app','other']);assert.deepEqual(m.topologicalSort({a:['external']}),['external','a']);assert.throws(()=>m.topologicalSort({a:['b'],b:['a']}));assert.deepEqual(m.topologicalSort({}),[]);
console.log('PASS');
})().catch(error => { console.error(error.message); process.exitCode = 1; });
