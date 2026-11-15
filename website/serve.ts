import { resolve, sep } from 'node:path';
const root=resolve(import.meta.dir,'dist');
const port=Number(process.env.PORT || 4173);
const server=Bun.serve({hostname:'127.0.0.1',port,async fetch(req){
  let path:string;try{path=decodeURIComponent(new URL(req.url).pathname);}catch{return new Response('Bad path',{status:400});}
  if(path==='/')return Response.redirect('/rigwell/',302);
  if(!path.startsWith('/rigwell/'))return new Response('Not found',{status:404});
  const filePath=resolve(root,path.slice('/rigwell/'.length)+(path.endsWith('/')?'index.html':''));
  if(!filePath.startsWith(root+sep))return new Response('Not found',{status:404});
  const file=Bun.file(filePath);return await file.exists()?new Response(file):new Response('Not found',{status:404});
}});
console.log(`Preview: ${server.url}rigwell/`);
