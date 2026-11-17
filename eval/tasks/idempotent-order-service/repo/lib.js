export function createService(store){let id=0;return {place(key,order){const result={id:++id,order};store.put(key,result);return result;}};}
