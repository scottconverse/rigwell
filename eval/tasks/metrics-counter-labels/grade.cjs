const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { spawnSync } = require('node:child_process');
const load = file => import(pathToFileURL(path.resolve(file)).href);
const cli = (args = [], input = '') => spawnSync(process.execPath, ['cli.js', ...args], { cwd: process.cwd(), encoding: 'utf8', input, timeout: 5000 });
(async () => {
const m = await load('lib.js');
const C=(await load('counter.js')).Counter,c=new C();c.inc({b:'2',a:'1'});c.inc({a:'1',b:'2'},2);assert.deepEqual(c.snapshot(),[{labels:{a:'1',b:'2'},value:3}]);const snapshot=c.snapshot();snapshot[0].labels.a='bad';snapshot[0].value=99;assert.equal(c.snapshot()[0].value,3);assert.equal(c.snapshot()[0].labels.a,'1');assert.throws(()=>c.inc({},-1));assert.throws(()=>c.inc({},NaN));const metrics=m.makeMetrics();metrics.record(200);metrics.record('200');assert.deepEqual(metrics.snapshot(),[{labels:{status:'200'},value:2}]);
console.log('PASS');
})().catch(error => { console.error(error.message); process.exitCode = 1; });
