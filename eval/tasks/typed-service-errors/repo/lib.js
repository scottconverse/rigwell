import {get} from './repository.js';export const handle=id=>({status:200,value:get(id)});
