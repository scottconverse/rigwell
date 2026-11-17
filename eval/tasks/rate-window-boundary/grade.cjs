const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { spawnSync } = require('node:child_process');
const load = file => import(pathToFileURL(path.resolve(file)).href);
const cli = (args = [], input = '') => spawnSync(process.execPath, ['cli.js', ...args], { cwd: process.cwd(), encoding: 'utf8', input, timeout: 5000 });
(async () => {
const m = await load('lib.js');
const l=new m.WindowLimiter(2,100);assert.equal(l.allow(0),true);assert.equal(l.allow(1),true);assert.equal(l.allow(2),false);assert.equal(l.allow(100),true);assert.equal(l.allow(100),false);assert.equal(l.allow(101),true);assert.throws(()=>l.allow(99));assert.throws(()=>new m.WindowLimiter(0,1));
console.log('PASS');
})().catch(error => { console.error(error.message); process.exitCode = 1; });
