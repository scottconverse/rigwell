import {Counter} from './counter.js';export function makeMetrics(){const c=new Counter();return {record:s=>c.inc({status:s}),snapshot:()=>c.snapshot()};}
