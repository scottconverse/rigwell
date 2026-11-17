import {insert,find} from './store.js';export const createUser=insert;export const getUser=find;export const formatUser=id=>{const r=find(id);return r.id+': '+r.name;};
