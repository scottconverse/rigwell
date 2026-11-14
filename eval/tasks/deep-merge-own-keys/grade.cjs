const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { spawnSync } = require('node:child_process');
const load = file => import(pathToFileURL(path.resolve(file)).href);
const cli = (args = [], input = '') => spawnSync(process.execPath, ['cli.js', ...args], { cwd: process.cwd(), encoding: 'utf8', input, timeout: 5000 });
(async () => {
const m = await load('lib.js');
const a={db:{host:'local',ports:[1]},keep:3},b={db:{ports:[2]}};assert.deepEqual(m.mergeConfig(a,b),{db:{host:'local',ports:[2]},keep:3});assert.deepEqual(a.db.ports,[1]);assert.deepEqual(b,{db:{ports:[2]}});assert.throws(()=>m.mergeConfig({},JSON.parse('{"db":{"__proto__":{"bad":true}}}')));assert.equal({}.bad,undefined);
console.log('PASS');
})().catch(error => { console.error(error.message); process.exitCode = 1; });
