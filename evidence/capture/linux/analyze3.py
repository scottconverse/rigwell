# One line per captured request: file, max_tokens, system block sizes, tool count, tool json chars, message count.
import json, glob, os
O = '/home/cap/out'
for f in sorted(glob.glob(O + '/*-requests/req-*.json')):
    r = json.load(open(f)); b = r.get('body') or {}
    s = b.get('system'); sl = [len(x.get('text', '')) for x in s] if isinstance(s, list) else ([len(s)] if s else [])
    tools = b.get('tools') or []
    msgs = b.get('messages') or []
    first = msgs[0].get('content') if msgs else None
    nfirst = len(first) if isinstance(first, list) else ('str' if first else 0)
    print(os.path.relpath(f, O), 'max_tokens=%s' % b.get('max_tokens'), 'system=%s' % sl, 'tools=%d' % len(tools),
          'toolchars=%d' % len(json.dumps(tools, ensure_ascii=False)), 'msgs=%d' % len(msgs), 'firstblocks=%s' % nfirst,
          'names=%s' % ','.join(t.get('name', '?') for t in tools))
