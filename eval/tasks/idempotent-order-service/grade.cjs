const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { spawnSync } = require('node:child_process');
const load = file => import(pathToFileURL(path.resolve(file)).href);
const cli = (args = [], input = '') => spawnSync(process.execPath, ['cli.js', ...args], { cwd: process.cwd(), encoding: 'utf8', input, timeout: 5000 });
(async () => {
const m = await load('lib.js');
const store=(await load('store.js')).createStore(),s=m.createService(store);const a=s.place('a',{sku:'x',quantity:2});assert.deepEqual(s.place('a',{quantity:2,sku:'x'}),a);assert.equal(store.size(),1);assert.throws(()=>s.place('a',{sku:'x',quantity:3}));assert.throws(()=>s.place('b',{sku:'x',quantity:0}));assert.equal(store.size(),1);assert.equal(s.place('b',{sku:'y',quantity:1}).id,2);
console.log('PASS');
})().catch(error => { console.error(error.message); process.exitCode = 1; });
