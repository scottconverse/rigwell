export const pick=(o,ks)=>Object.fromEntries(ks.filter(k=>Object.hasOwn(o,k)).map(k=>[k,o[k]]));
