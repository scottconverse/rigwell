const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { spawnSync } = require('node:child_process');
const load = file => import(pathToFileURL(path.resolve(file)).href);
const cli = (args = [], input = '') => spawnSync(process.execPath, ['cli.js', ...args], { cwd: process.cwd(), encoding: 'utf8', input, timeout: 5000 });
(async () => {
const m = await load('lib.js');
const u={theme:'light',retries:2,enabled:true},p={retries:0,enabled:false,extra:'ignored'};assert.deepEqual(m.resolveSettings(u,p),{theme:'light',retries:0,enabled:false});assert.equal(u.retries,2);assert.deepEqual(m.resolveSettings(),{theme:'dark',retries:3,enabled:true});assert.throws(()=>m.resolveSettings({theme:'blue'},{}));assert.throws(()=>m.resolveSettings({}, {enabled:null}));assert.throws(()=>m.resolveSettings({retries:-1},{}));
console.log('PASS');
})().catch(error => { console.error(error.message); process.exitCode = 1; });
