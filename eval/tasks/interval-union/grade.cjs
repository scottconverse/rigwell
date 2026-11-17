const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { spawnSync } = require('node:child_process');
const load = file => import(pathToFileURL(path.resolve(file)).href);
const cli = (args = [], input = '') => spawnSync(process.execPath, ['cli.js', ...args], { cwd: process.cwd(), encoding: 'utf8', input, timeout: 5000 });
(async () => {
const m = await load('lib.js');
const input=[[5,7],[1,3],[3,6],[10,10]];assert.deepEqual(m.mergeIntervals(input),[[1,7],[10,10]]);assert.deepEqual(input,[[5,7],[1,3],[3,6],[10,10]]);assert.deepEqual(m.mergeIntervals([]),[]);assert.throws(()=>m.mergeIntervals([[3,2]]));assert.throws(()=>m.mergeIntervals([[0,Infinity]]));
console.log('PASS');
})().catch(error => { console.error(error.message); process.exitCode = 1; });
