export function pageOffset(p,s){if(!Number.isSafeInteger(p)||p<1||!Number.isSafeInteger(s)||s<1||!Number.isSafeInteger((p-1)*s))throw Error('Invalid page');return (p-1)*s;}
