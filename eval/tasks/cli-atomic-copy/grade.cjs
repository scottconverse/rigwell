const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { spawnSync } = require('node:child_process');
const load = file => import(pathToFileURL(path.resolve(file)).href);
const cli = (args = [], input = '') => spawnSync(process.execPath, ['cli.js', ...args], { cwd: process.cwd(), encoding: 'utf8', input, timeout: 5000 });
(async () => {
const data=Buffer.from([0,255,1,13]);fs.writeFileSync('source.bin',data);assert.equal(cli(['source.bin','out/target.bin']).status,0);assert.deepEqual(fs.readFileSync('out/target.bin'),data);fs.writeFileSync('source.bin','next');assert.equal(cli(['source.bin','out/target.bin']).status,2);assert.deepEqual(fs.readFileSync('out/target.bin'),data);assert.equal(cli(['source.bin','out/target.bin','--force']).status,0);assert.equal(fs.readFileSync('out/target.bin','utf8'),'next');assert.equal(cli(['missing','out/other']).status,2);assert.deepEqual(fs.readdirSync('out'),['target.bin']);assert.match(fs.readFileSync('cli.js','utf8'),/rename/);
console.log('PASS');
})().catch(error => { console.error(error.message); process.exitCode = 1; });
