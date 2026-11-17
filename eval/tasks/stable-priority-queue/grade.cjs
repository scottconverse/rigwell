const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { spawnSync } = require('node:child_process');
const load = file => import(pathToFileURL(path.resolve(file)).href);
const cli = (args = [], input = '') => spawnSync(process.execPath, ['cli.js', ...args], { cwd: process.cwd(), encoding: 'utf8', input, timeout: 5000 });
(async () => {
const m = await load('lib.js');
const q=new m.PriorityQueue();q.push('a',2);q.push('b',1);q.push('c',1);q.push('d',-1);assert.equal(q.size,4);assert.deepEqual([q.pop(),q.pop(),q.pop(),q.pop(),q.pop()],['d','b','c','a',undefined]);assert.equal(q.size,0);assert.throws(()=>q.push('x',NaN));
console.log('PASS');
})().catch(error => { console.error(error.message); process.exitCode = 1; });
