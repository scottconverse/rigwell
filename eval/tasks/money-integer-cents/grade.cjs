const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { spawnSync } = require('node:child_process');
const load = file => import(pathToFileURL(path.resolve(file)).href);
const cli = (args = [], input = '') => spawnSync(process.execPath, ['cli.js', ...args], { cwd: process.cwd(), encoding: 'utf8', input, timeout: 5000 });
(async () => {
const m = await load('lib.js');
assert.equal(m.totalCents([{price:'19.99',quantity:3},{price:'0.29',quantity:1}]),6026);assert.equal(m.totalCents([{price:'2.5',quantity:0}]),0);for(const l of [{price:'1.234',quantity:1},{price:'1x',quantity:1},{price:'1',quantity:-1},{price:'9007199254740993',quantity:1}])assert.throws(()=>m.totalCents([l]));
console.log('PASS');
})().catch(error => { console.error(error.message); process.exitCode = 1; });
