export const createStore=()=>{const m=new Map();return {get:k=>m.get(k),put:(k,v)=>m.set(k,v),size:()=>m.size};};
