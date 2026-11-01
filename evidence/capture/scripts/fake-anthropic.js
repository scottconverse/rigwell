// Fake Anthropic Messages API for an offline capture run.
// Saves every request it receives as JSON, answers with a short scripted reply.
// Usage: node fake-anthropic.js <port> <outDir>
const http = require('http');
const fs = require('fs');
const path = require('path');

const port = Number(process.argv[2] || 18080);
const outDir = process.argv[3];
fs.mkdirSync(outDir, { recursive: true });
let n = 0;

function redactHeaders(h) {
  const out = {};
  for (const [k, v] of Object.entries(h)) {
    out[k] = /^(authorization|x-api-key|cookie)$/i.test(k) ? '<redacted>' : v;
  }
  return out;
}

function sse(res, events) {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
  for (const [type, data] of events) res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
  res.end();
}

function replyText(body) {
  // A compaction request asks for a summary; anything else gets a short answer.
  const sys = JSON.stringify(body.system || '');
  const last = JSON.stringify((body.messages || []).slice(-1));
  if (/summar/i.test(sys) || /summar/i.test(last)) return '<summary>Fake summary from the capture server.</summary>';
  return 'hi';
}

http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const raw = Buffer.concat(chunks).toString('utf8');
    let body = null;
    try { body = raw ? JSON.parse(raw) : null; } catch { body = { unparsed: raw.slice(0, 200000) }; }
    const id = String(++n).padStart(3, '0');
    const rec = { seq: n, time: new Date().toISOString(), method: req.method, url: req.url, headers: redactHeaders(req.headers), body };
    fs.writeFileSync(path.join(outDir, `req-${id}.json`), JSON.stringify(rec, null, 2));

    const url = req.url.split('?')[0];
    if (req.method === 'POST' && url.endsWith('/messages/count_tokens')) {
      const size = raw.length;
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ input_tokens: Math.ceil(size / 4) }));
    }
    if (req.method === 'POST' && url.endsWith('/messages')) {
      const text = replyText(body || {});
      const model = (body && body.model) || 'fake-model';
      const usage = { input_tokens: Math.ceil(raw.length / 4), output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
      if (body && body.stream) {
        return sse(res, [
          ['message_start', { message: { id: `msg_fake_${id}`, type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage } }],
          ['content_block_start', { index: 0, content_block: { type: 'text', text: '' } }],
          ['content_block_delta', { index: 0, delta: { type: 'text_delta', text } }],
          ['content_block_stop', { index: 0 }],
          ['message_delta', { delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 5 } }],
          ['message_stop', {}],
        ]);
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ id: `msg_fake_${id}`, type: 'message', role: 'assistant', model, content: [{ type: 'text', text }], stop_reason: 'end_turn', stop_sequence: null, usage }));
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ type: 'error', error: { type: 'not_found_error', message: 'fake server: no such route' } }));
  });
}).listen(port, '127.0.0.1', () => console.log(`fake-anthropic listening on ${port}, saving to ${outDir}`));
