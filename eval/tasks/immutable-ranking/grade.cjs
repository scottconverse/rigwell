const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { spawnSync } = require('node:child_process');
const load = file => import(pathToFileURL(path.resolve(file)).href);
const cli = (args = [], input = '') => spawnSync(process.execPath, ['cli.js', ...args], { cwd: process.cwd(), encoding: 'utf8', input, timeout: 5000 });
(async () => {
const m = await load('lib.js');
const rows=Object.freeze([Object.freeze({id:'a',score:2}),Object.freeze({id:'b',score:3}),Object.freeze({id:'c',score:2})]);assert.deepEqual(m.rank(rows),[{id:'b',score:3,rank:1},{id:'a',score:2,rank:2},{id:'c',score:2,rank:3}]);assert.equal(rows[0].rank,undefined);assert.deepEqual(m.rank([]),[]);
console.log('PASS');
})().catch(error => { console.error(error.message); process.exitCode = 1; });
