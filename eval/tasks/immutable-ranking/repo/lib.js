export function rank(rows){return rows.sort((a,b)=>b.score-a.score).map((r,i)=>Object.assign(r,{rank:i+1}));}
