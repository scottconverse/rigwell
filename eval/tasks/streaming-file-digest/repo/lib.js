import {readFileSync} from 'node:fs';import {createHash} from 'node:crypto';export async function digest(p){return createHash('sha256').update(readFileSync(p)).digest('hex');}
