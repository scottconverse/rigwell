export class Counter{constructor(){this.rows=[];}inc(labels,amount=1){this.rows.push({labels,value:amount});}snapshot(){return this.rows;}}
