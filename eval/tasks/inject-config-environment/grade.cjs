const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { spawnSync } = require('node:child_process');
const load = file => import(pathToFileURL(path.resolve(file)).href);
const cli = (args = [], input = '') => spawnSync(process.execPath, ['cli.js', ...args], { cwd: process.cwd(), encoding: 'utf8', input, timeout: 5000 });
(async () => {
const m = await load('lib.js');
const c=await load('config.js');assert.deepEqual(c.parseConfig({}),{port:8080,debug:false});assert.deepEqual(c.parseConfig({PORT:'3000',DEBUG:'false'}),{port:3000,debug:false});assert.equal(c.parseConfig({DEBUG:'1'}).debug,true);for(const PORT of ['0','65536','1.5','abc'])assert.throws(()=>c.parseConfig({PORT}));process.env.PORT='4001';assert.equal(m.loadConfig().port,4001);process.env.PORT='4002';assert.equal(m.loadConfig().port,4002);
console.log('PASS');
})().catch(error => { console.error(error.message); process.exitCode = 1; });
