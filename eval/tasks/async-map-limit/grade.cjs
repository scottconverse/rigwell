const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { spawnSync } = require('node:child_process');
const load = file => import(pathToFileURL(path.resolve(file)).href);
const cli = (args = [], input = '') => spawnSync(process.execPath, ['cli.js', ...args], { cwd: process.cwd(), encoding: 'utf8', input, timeout: 5000 });
(async () => {
const m = await load('lib.js');
let active=0,peak=0;assert.deepEqual(await m.mapLimit([3,1,2,0],2,async v=>{active++;peak=Math.max(peak,active);await new Promise(r=>setTimeout(r,v*2));active--;return v*2;}),[6,2,4,0]);assert.equal(peak,2);assert.deepEqual(await m.mapLimit([],2,()=>0),[]);await assert.rejects(()=>m.mapLimit([1],0,()=>0));await assert.rejects(()=>m.mapLimit([1],1,()=>{throw Error('failure');}),/failure/);
console.log('PASS');
})().catch(error => { console.error(error.message); process.exitCode = 1; });
