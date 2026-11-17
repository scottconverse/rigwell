export const totalCents=lines=>lines.reduce((n,l)=>n+parseFloat(l.price)*100*l.quantity,0);
