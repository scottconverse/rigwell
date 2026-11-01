# Summarize captured requests: structure and sizes only, no prompt text.
import json, glob, os

def blen(x):
    return len(json.dumps(x, ensure_ascii=False))

for f in sorted(glob.glob('/home/cap/out/*-requests/req-*.json')):
    r = json.load(open(f))
    b = r.get('body') or {}
    print('=' * 70)
    print(os.path.relpath(f, '/home/cap/out'), r['method'], r['url'], 'raw_len=', r.get('raw_length'))
    h = r['headers']
    print('headers:', {k: v for k, v in h.items() if k.lower() not in ('host', 'content-length', 'connection', 'accept-encoding')})
    print('body keys:', sorted(b.keys()))
    for k in ('model', 'max_tokens', 'stream', 'temperature', 'top_p', 'top_k', 'thinking', 'tool_choice', 'metadata', 'stop_sequences', 'context_management', 'betas'):
        if k in b:
            v = b[k]
            print('  %s = %s' % (k, json.dumps(v)[:200]))
    s = b.get('system')
    if isinstance(s, str):
        print('system: string chars=%d' % len(s))
    elif isinstance(s, list):
        print('system: %d blocks' % len(s))
        for i, blk in enumerate(s):
            t = blk.get('text', '')
            print('  [%d] type=%s chars=%d cache_control=%s first_words=%r' % (i, blk.get('type'), len(t), blk.get('cache_control'), ' '.join(t.split()[:3])))
    tools = b.get('tools') or []
    print('tools: %d, total json chars=%d' % (len(tools), blen(tools)))
    for t in tools:
        props = list(((t.get('input_schema') or {}).get('properties') or {}).keys())
        print('  - %-22s type=%s desc_chars=%d schema_chars=%d params=%s cache=%s' % (
            t.get('name'), t.get('type', '-'), len(t.get('description') or ''), blen(t.get('input_schema') or {}), props, t.get('cache_control')))
    msgs = b.get('messages') or []
    print('messages: %d' % len(msgs))
    for i, m in enumerate(msgs):
        c = m.get('content')
        if isinstance(c, str):
            print('  [%d] %s str chars=%d' % (i, m.get('role'), len(c)))
        else:
            parts = []
            for blk in c or []:
                t = blk.get('type')
                size = len(blk.get('text', '')) if t == 'text' else blen(blk)
                parts.append('%s:%d%s' % (t, size, '+cache' if blk.get('cache_control') else ''))
            print('  [%d] %s %s' % (i, m.get('role'), ' '.join(parts)))
