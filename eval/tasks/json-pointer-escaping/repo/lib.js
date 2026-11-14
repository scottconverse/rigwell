export function getPointer(doc,p){return p.split('/').slice(1).reduce((v,k)=>v?.[k],doc);}
