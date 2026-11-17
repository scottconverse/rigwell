const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { spawnSync } = require('node:child_process');
const load = file => import(pathToFileURL(path.resolve(file)).href);
const cli = (args = [], input = '') => spawnSync(process.execPath, ['cli.js', ...args], { cwd: process.cwd(), encoding: 'utf8', input, timeout: 5000 });
(async () => {
const m = await load('lib.js');
const d=new m.EventDecoder();assert.deepEqual(d.push(':keep\r\ndata: one\r'),[]);assert.deepEqual(d.push('\ndata: two\r\nevent: update\r\nid: 7\r\n\r\n'),[{event:'update',data:'one\ntwo',id:'7'}]);assert.deepEqual(d.push('data: tail'),[]);assert.deepEqual(d.finish(),[{event:'message',data:'tail',id:'7'}]);assert.deepEqual(d.finish(),[]);
console.log('PASS');
})().catch(error => { console.error(error.message); process.exitCode = 1; });
