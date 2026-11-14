const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { spawnSync } = require('node:child_process');
const load = file => import(pathToFileURL(path.resolve(file)).href);
const cli = (args = [], input = '') => spawnSync(process.execPath, ['cli.js', ...args], { cwd: process.cwd(), encoding: 'utf8', input, timeout: 5000 });
(async () => {
const m = await load('lib.js');
const seen=[];assert.deepEqual(await m.importRows([' 2 ','3'],async v=>{seen.push(v);return v*2;}),[4,6]);assert.deepEqual(seen,[2,3]);const c=new AbortController();let n=0;await assert.rejects(()=>m.importRows(['1','2'],async(v,signal)=>{assert.equal(signal,c.signal);n++;c.abort(Error('stop'));return v;},c.signal),/stop/);assert.equal(n,1);await assert.rejects(()=>m.importRows([''],async()=>0));const p=await load('parser.js');assert.throws(()=>p.parseRow('Infinity'));
console.log('PASS');
})().catch(error => { console.error(error.message); process.exitCode = 1; });
