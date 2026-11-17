const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { spawnSync } = require('node:child_process');
const load = file => import(pathToFileURL(path.resolve(file)).href);
const cli = (args = [], input = '') => spawnSync(process.execPath, ['cli.js', ...args], { cwd: process.cwd(), encoding: 'utf8', input, timeout: 5000 });
(async () => {
fs.mkdirSync('data/sub',{recursive:true});fs.writeFileSync('data/z.txt','abc');fs.writeFileSync('data/sub/a.txt','xy');fs.symlinkSync(require('node:path').resolve('data/z.txt'),'data/link.txt');const r=cli(['data']);assert.equal(r.status,0);assert.equal(r.stdout,'sub/a.txt\t2\nz.txt\t3\n');assert.equal(cli(['absent']).status,2);
console.log('PASS');
})().catch(error => { console.error(error.message); process.exitCode = 1; });
