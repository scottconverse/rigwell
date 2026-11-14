const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { spawnSync } = require('node:child_process');
const load = file => import(pathToFileURL(path.resolve(file)).href);
const cli = (args = [], input = '') => spawnSync(process.execPath, ['cli.js', ...args], { cwd: process.cwd(), encoding: 'utf8', input, timeout: 5000 });
(async () => {
fs.writeFileSync('in.json',JSON.stringify({schemaVersion:1,users:[{name:'A'},{name:'B',enabled:false}]}));assert.equal(cli(['in.json','out.json']).status,0);assert.deepEqual(JSON.parse(fs.readFileSync('out.json')),{schemaVersion:2,accounts:[{displayName:'A',active:true},{displayName:'B',active:false}]});fs.copyFileSync('out.json','in.json');assert.equal(cli(['in.json','copy.json']).status,0);assert.deepEqual(JSON.parse(fs.readFileSync('copy.json')),JSON.parse(fs.readFileSync('out.json')));fs.writeFileSync('in.json','{"schemaVersion":9}');const old=fs.readFileSync('out.json','utf8');assert.equal(cli(['in.json','out.json']).status,2);assert.equal(fs.readFileSync('out.json','utf8'),old);
console.log('PASS');
})().catch(error => { console.error(error.message); process.exitCode = 1; });
