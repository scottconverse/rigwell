const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { spawnSync } = require('node:child_process');
const load = file => import(pathToFileURL(path.resolve(file)).href);
const cli = (args = [], input = '') => spawnSync(process.execPath, ['cli.js', ...args], { cwd: process.cwd(), encoding: 'utf8', input, timeout: 5000 });
(async () => {
const m = await load('lib.js');
const seen=[];assert.equal(await m.retry(i=>{seen.push(i);if(i<2)throw Error('again');return 8;},{attempts:3}),8);assert.deepEqual(seen,[0,1,2]);const e=Error('last');await assert.rejects(()=>m.retry(()=>{throw e;},{attempts:2}),v=>v===e);const c=new AbortController();let n=0;await assert.rejects(()=>m.retry(()=>{n++;c.abort(Error('stop'));throw e;},{attempts:4,signal:c.signal}),/stop/);assert.equal(n,1);await assert.rejects(()=>m.retry(()=>0,{attempts:0}));
console.log('PASS');
})().catch(error => { console.error(error.message); process.exitCode = 1; });
