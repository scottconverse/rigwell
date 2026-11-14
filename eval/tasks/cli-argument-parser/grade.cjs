const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { spawnSync } = require('node:child_process');
const load = file => import(pathToFileURL(path.resolve(file)).href);
const cli = (args = [], input = '') => spawnSync(process.execPath, ['cli.js', ...args], { cwd: process.cwd(), encoding: 'utf8', input, timeout: 5000 });
(async () => {
assert.equal(cli(['--name=Halo','--count','2']).stdout,'Hello, Halo!\nHello, Halo!\n');assert.equal(cli(['--name','two words']).stdout,'Hello, two words!\n');for(const args of [['--bogus'],['--count','0'],['--count','1.5'],['--name'],['--','oops']]){const r=cli(args);assert.equal(r.status,2);assert(r.stderr.trim());}assert.equal(cli(['--']).status,0);
console.log('PASS');
})().catch(error => { console.error(error.message); process.exitCode = 1; });
