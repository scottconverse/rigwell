const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { spawnSync } = require('node:child_process');
const load = file => import(pathToFileURL(path.resolve(file)).href);
const cli = (args = [], input = '') => spawnSync(process.execPath, ['cli.js', ...args], { cwd: process.cwd(), encoding: 'utf8', input, timeout: 5000 });
(async () => {
let r=cli(['a.b'],'xa.b\r\naxb\r\na.b');assert.equal(r.status,0);assert.equal(r.stdout,'xa.b\na.b\n');r=cli(['ABSENT'],'hello\n');assert.equal(r.status,1);assert.equal(r.stdout,'');assert.equal(cli([],'').status,2);
console.log('PASS');
})().catch(error => { console.error(error.message); process.exitCode = 1; });
