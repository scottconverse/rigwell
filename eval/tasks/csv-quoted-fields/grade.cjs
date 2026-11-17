const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { spawnSync } = require('node:child_process');
const load = file => import(pathToFileURL(path.resolve(file)).href);
const cli = (args = [], input = '') => spawnSync(process.execPath, ['cli.js', ...args], { cwd: process.cwd(), encoding: 'utf8', input, timeout: 5000 });
(async () => {
const m = await load('lib.js');
assert.deepEqual(m.parseCsvLine('a,"b,c","d""e",'),['a','b,c','d"e','']);assert.deepEqual(m.parseCsvLine(''),['']);assert.throws(()=>m.parseCsvLine('"bad'));
console.log('PASS');
})().catch(error => { console.error(error.message); process.exitCode = 1; });
