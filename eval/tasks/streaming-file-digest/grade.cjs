const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { spawnSync } = require('node:child_process');
const load = file => import(pathToFileURL(path.resolve(file)).href);
const cli = (args = [], input = '') => spawnSync(process.execPath, ['cli.js', ...args], { cwd: process.cwd(), encoding: 'utf8', input, timeout: 5000 });
(async () => {
const m = await load('lib.js');
const {createHash}=require('node:crypto');for(const [p,data] of [['empty.bin',Buffer.alloc(0)],['data.bin',Buffer.from([0,255,13,10,0,4])]]){fs.writeFileSync(p,data);assert.equal(await m.digest(p),createHash('sha256').update(data).digest('hex'));}await assert.rejects(()=>m.digest('missing.bin'));const code=fs.readFileSync('lib.js','utf8');assert(!/readFile|chunks\.push|Buffer\.concat/.test(code));assert.match(code,/createReadStream/);
console.log('PASS');
})().catch(error => { console.error(error.message); process.exitCode = 1; });
