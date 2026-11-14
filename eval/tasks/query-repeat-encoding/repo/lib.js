export const parseQuery=s=>Object.fromEntries(s.replace(/^\?/,'').split('&').map(x=>x.split('=')));
