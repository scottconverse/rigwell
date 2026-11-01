# Fake Anthropic Messages API for an offline capture run (Python port of fake-anthropic.js).
# Saves every request as JSON; answers with a short scripted reply.
# Usage: python3 fake_anthropic.py <port> <outDir>
import json, os, sys, re, math, threading
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

port = int(sys.argv[1]); out = sys.argv[2]; os.makedirs(out, exist_ok=True)
lock = threading.Lock(); count = [0]
SECRET = re.compile(r'^(authorization|x-api-key|cookie)$', re.I)


def reply_text(body):
    sys_s = json.dumps(body.get('system') or '')
    last = json.dumps((body.get('messages') or [])[-1:])
    if re.search('summar', sys_s + last, re.I):
        return '<summary>Fake summary from the capture server.</summary>'
    return 'hi'


class H(BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'

    def log_message(self, *a):
        pass

    def _send(self, code, ctype, data):
        b = data.encode() if isinstance(data, str) else data
        self.send_response(code)
        self.send_header('content-type', ctype)
        self.send_header('content-length', str(len(b)))
        self.end_headers()
        self.wfile.write(b)

    def _handle(self):
        n = int(self.headers.get('content-length') or 0)
        raw = self.rfile.read(n).decode('utf-8', 'replace') if n else ''
        try:
            body = json.loads(raw) if raw else None
        except Exception:
            body = {'unparsed': raw[:200000]}
        with lock:
            count[0] += 1
            seq = count[0]
        rec = {'seq': seq, 'time': datetime.now(timezone.utc).isoformat(), 'method': self.command, 'url': self.path,
               'headers': {k: ('<redacted>' if SECRET.match(k) else v) for k, v in self.headers.items()},
               'body': body, 'raw_length': len(raw)}
        with open(os.path.join(out, 'req-%03d.json' % seq), 'w') as f:
            json.dump(rec, f, indent=2)
        url = self.path.split('?')[0]
        body = body if isinstance(body, dict) else {}
        if self.command == 'POST' and url.endswith('/messages/count_tokens'):
            return self._send(200, 'application/json', json.dumps({'input_tokens': math.ceil(len(raw) / 4)}))
        if self.command == 'POST' and url.endswith('/messages'):
            text = reply_text(body)
            model = body.get('model') or 'fake-model'
            mid = 'msg_fake_%03d' % seq
            usage = {'input_tokens': math.ceil(len(raw) / 4), 'output_tokens': 5,
                     'cache_read_input_tokens': 0, 'cache_creation_input_tokens': 0}
            if body.get('stream'):
                ev = [('message_start', {'message': {'id': mid, 'type': 'message', 'role': 'assistant', 'model': model,
                                                     'content': [], 'stop_reason': None, 'stop_sequence': None, 'usage': usage}}),
                      ('content_block_start', {'index': 0, 'content_block': {'type': 'text', 'text': ''}}),
                      ('content_block_delta', {'index': 0, 'delta': {'type': 'text_delta', 'text': text}}),
                      ('content_block_stop', {'index': 0}),
                      ('message_delta', {'delta': {'stop_reason': 'end_turn', 'stop_sequence': None}, 'usage': {'output_tokens': 5}}),
                      ('message_stop', {})]
                data = ''.join('event: %s\ndata: %s\n\n' % (t, json.dumps(dict(type=t, **d))) for t, d in ev)
                return self._send(200, 'text/event-stream', data)
            return self._send(200, 'application/json', json.dumps({
                'id': mid, 'type': 'message', 'role': 'assistant', 'model': model,
                'content': [{'type': 'text', 'text': text}], 'stop_reason': 'end_turn', 'stop_sequence': None, 'usage': usage}))
        return self._send(404, 'application/json', json.dumps(
            {'type': 'error', 'error': {'type': 'not_found_error', 'message': 'fake server: no such route'}}))

    do_GET = do_POST = do_PUT = do_DELETE = do_PATCH = _handle


print('fake-anthropic listening on %d, saving to %s' % (port, out), flush=True)
ThreadingHTTPServer(('127.0.0.1', port), H).serve_forever()
