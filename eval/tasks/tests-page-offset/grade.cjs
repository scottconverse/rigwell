const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { spawnSync } = require('node:child_process');
const load = file => import(pathToFileURL(path.resolve(file)).href);
const cli = (args = [], input = '') => spawnSync(process.execPath, ['cli.js', ...args], { cwd: process.cwd(), encoding: 'utf8', input, timeout: 5000 });
(async () => {
assert.equal(fs.readFileSync("lib.js", "utf8").replace(/\r\n/g, "\n"), "export function pageOffset(p,s){if(!Number.isSafeInteger(p)||p<1||!Number.isSafeInteger(s)||s<1||!Number.isSafeInteger((p-1)*s))throw Error('Invalid page');return (p-1)*s;}\n", "Keep the implementation unchanged");
const m = await load('lib.js');
const original=fs.readFileSync('lib.js','utf8');const run=()=>require('node:child_process').spawnSync(process.execPath,['--test','checks.cjs'],{cwd:process.cwd(),encoding:'utf8',timeout:5000});assert.equal(run().status,0,'Tests must pass the valid implementation');try{for(const mutant of ["export const pageOffset=(p,s)=>p*s;", "export const pageOffset=(p,s)=>(p-1)*s;", "export function pageOffset(p,s){if(!Number.isInteger(p)||p<1||!Number.isInteger(s)||s<1)throw Error('bad');return (p-1)*s;}"]){fs.writeFileSync('lib.js',mutant);assert.notEqual(run().status,0,'Tests missed a required regression');}}finally{fs.writeFileSync('lib.js',original);}
console.log('PASS');
})().catch(error => { console.error(error.message); process.exitCode = 1; });
