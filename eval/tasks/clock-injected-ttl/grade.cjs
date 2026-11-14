const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { spawnSync } = require('node:child_process');
const load = file => import(pathToFileURL(path.resolve(file)).href);
const cli = (args = [], input = '') => spawnSync(process.execPath, ['cli.js', ...args], { cwd: process.cwd(), encoding: 'utf8', input, timeout: 5000 });
(async () => {
const m = await load('lib.js');
let now=0;const c=(await load('cache.js')).createCache(()=>now);c.set('a',1,10);assert.deepEqual(c.get('a'),{value:1,expires:10});now=10;assert.equal(c.get('a'),undefined);assert.equal(c.size(),0);assert.throws(()=>c.set('a',1,-1));const s=m.makeService(()=>now);let calls=0;const fn=()=>{calls++;return undefined;};s.remember('x',fn,5);s.remember('x',fn,5);assert.equal(calls,1);now=15;s.remember('x',fn,5);assert.equal(calls,2);
console.log('PASS');
})().catch(error => { console.error(error.message); process.exitCode = 1; });
