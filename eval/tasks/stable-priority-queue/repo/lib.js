export class PriorityQueue{constructor(){this.values=[];}push(v,p){this.values.push(v);}pop(){return this.values.shift();}get size(){return this.values.length;}}
