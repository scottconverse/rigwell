const rows=[];export function insert(name){const row={id:rows.length+1,name};rows.push(row);return row;}export const find=id=>rows.find(r=>r.id===id);
