const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { spawnSync } = require('node:child_process');
const load = file => import(pathToFileURL(path.resolve(file)).href);
const cli = (args = [], input = '') => spawnSync(process.execPath, ['cli.js', ...args], { cwd: process.cwd(), encoding: 'utf8', input, timeout: 5000 });
(async () => {
const m = await load('lib.js');
assert.deepEqual(m.page(0,2),{items:[{id:1},{id:2}],nextCursor:2});assert.deepEqual(m.page(2,2),{items:[{id:5},{id:8}],nextCursor:null});assert.deepEqual(m.page(8,2),{items:[],nextCursor:null});assert.throws(()=>m.page(-1,2));assert.throws(()=>m.page(0,0));const r=await load('repository.js');assert.deepEqual(r.rows,[{id:8},{id:2},{id:5},{id:1}]);assert.deepEqual(r.list(2,1),[{id:5}]);
console.log('PASS');
})().catch(error => { console.error(error.message); process.exitCode = 1; });
