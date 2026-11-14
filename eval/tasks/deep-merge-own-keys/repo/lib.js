export function mergeConfig(a,b){for(const k in b){if(b[k]&&typeof b[k]==='object')a[k]=mergeConfig(a[k]||{},b[k]);else a[k]=b[k];}return a;}
