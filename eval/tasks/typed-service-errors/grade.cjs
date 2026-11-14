const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { spawnSync } = require('node:child_process');
const load = file => import(pathToFileURL(path.resolve(file)).href);
const cli = (args = [], input = '') => spawnSync(process.execPath, ['cli.js', ...args], { cwd: process.cwd(), encoding: 'utf8', input, timeout: 5000 });
(async () => {
const m = await load('lib.js');
const e=await load('errors.js'),r=await load('repository.js');assert(new e.ValidationError() instanceof Error);assert.throws(()=>r.get(9),e.NotFoundError);assert.deepEqual(m.handle(1),{status:200,value:'one'});assert.deepEqual(m.handle(9),{status:404});assert.deepEqual(m.handle(0),{status:400});assert.deepEqual(m.handle(1.5),{status:400});
console.log('PASS');
})().catch(error => { console.error(error.message); process.exitCode = 1; });
