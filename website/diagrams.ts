import mermaid from '../desktop/node_modules/mermaid/dist/mermaid.esm.mjs';
mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', theme: 'neutral', fontFamily: 'system-ui, sans-serif', flowchart: { htmlLabels: false } });
await mermaid.run({ querySelector: '.mermaid' });
