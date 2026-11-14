const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { spawnSync } = require('node:child_process');
const load = file => import(pathToFileURL(path.resolve(file)).href);
const cli = (args = [], input = '') => spawnSync(process.execPath, ['cli.js', ...args], { cwd: process.cwd(), encoding: 'utf8', input, timeout: 5000 });
(async () => {
const m = await load('lib.js');
const c=new m.LruCache(2);c.set('a',1);c.set('b',2);assert.equal(c.get('a'),1);c.set('c',3);assert.equal(c.get('b'),undefined);c.set('a',4);c.set('d',5);assert.equal(c.get('c'),undefined);assert.equal(c.get('a'),4);assert.throws(()=>new m.LruCache(0));
console.log('PASS');
})().catch(error => { console.error(error.message); process.exitCode = 1; });
