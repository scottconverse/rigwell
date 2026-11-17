const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { spawnSync } = require('node:child_process');
const load = file => import(pathToFileURL(path.resolve(file)).href);
const cli = (args = [], input = '') => spawnSync(process.execPath, ['cli.js', ...args], { cwd: process.cwd(), encoding: 'utf8', input, timeout: 5000 });
(async () => {
const m = await load('lib.js');
const x={Token:'secret',nested:[{password:'pw',passwordHint:'hint'}],none:null};assert.deepEqual(m.redact(x,['token','PASSWORD']),{Token:'[redacted]',nested:[{password:'[redacted]',passwordHint:'hint'}],none:null});assert.equal(x.Token,'secret');assert.notEqual(m.redact(x,[]),x);
console.log('PASS');
})().catch(error => { console.error(error.message); process.exitCode = 1; });
