const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { spawnSync } = require('node:child_process');
const load = file => import(pathToFileURL(path.resolve(file)).href);
const cli = (args = [], input = '') => spawnSync(process.execPath, ['cli.js', ...args], { cwd: process.cwd(), encoding: 'utf8', input, timeout: 5000 });
(async () => {
const m = await load('lib.js');
const f=await load('format.js');assert.equal(f.formatCents(-123), '-$1.23');assert.equal(m.invoice({name:'A',cents:0}),'A: $0.00');assert.equal(m.invoice({name:'B',cents:1205}),'B: $12.05');assert.throws(()=>f.formatCents(1.2));assert.match(fs.readFileSync('lib.js','utf8'),/import[\s\S]*format/);
console.log('PASS');
})().catch(error => { console.error(error.message); process.exitCode = 1; });
