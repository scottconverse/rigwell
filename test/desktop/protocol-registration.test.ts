import {test,expect} from 'bun:test';
import {mkdtempSync,mkdirSync,writeFileSync,symlinkSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {verifyProtocolRegistration} from '../../desktop/packaging/protocol-registration.ts';

test('installed URL handler resolves directory aliases but rejects another executable or missing URL argument',()=>{
 const root=mkdtempSync(join(tmpdir(),'rigwell-protocol-'));
 try{
  const physical=join(root,'physical'),alias=join(root,'alias');mkdirSync(physical);
  const exe=join(physical,'rigwell.exe');writeFileSync(exe,'fixture');
  symlinkSync(physical,alias,process.platform==='win32'?'junction':'dir');
  expect(()=>verifyProtocolRegistration({protocol:'',command:`"${exe}" "%1"`},join(alias,'rigwell.exe'))).not.toThrow();
  const other=join(physical,'other.exe');writeFileSync(other,'other');
  expect(()=>verifyProtocolRegistration({protocol:'',command:`"${other}" "%1"`},exe)).toThrow('mismatch');
  expect(()=>verifyProtocolRegistration({protocol:'',command:`"${exe}"`},exe)).toThrow('Invalid');
  expect(()=>verifyProtocolRegistration({protocol:null,command:`"${exe}" "%1"`},exe)).toThrow('Invalid');
 }finally{rmSync(root,{recursive:true,force:true});}
});
