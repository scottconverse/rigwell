# Tally pilot runs. Usage: python -I tally.py <runsDir> <id>...
import json, sys, os, collections
for rid in sys.argv[2:]:
    d = os.path.join(sys.argv[1], rid); s = json.load(open(os.path.join(d, 'summary.json'), encoding='utf-8'))
    r = s['result']; u = r['tokenUsage']; msgs = r['messages']
    model_calls = [m for m in msgs if m.get('type') == 'tool_call' and str(m.get('toolUseId', '')).startswith('toolu_')]
    inner = [m for m in msgs if m.get('type') == 'tool_call' and not str(m.get('toolUseId', '')).startswith('toolu_')]
    users = sum(1 for m in msgs if m.get('type') == 'user')
    kinds = collections.Counter()
    for l in open(os.path.join(d, 'jsonrpc.jsonl'), encoding='utf-8'):
        m = json.loads(l)['m']
        if m.get('method') == 'droid.session_notification':
            n = m['params'].get('notification', m['params']); kinds[n.get('type', '?')] += 1
    inp = u['inputTokens'] + u['cacheCreationTokens'] + u['cacheReadTokens']
    print(json.dumps({'id': rid, 'mode': s['settings'].get('toolExecutionMode'), 'passed': s['grade']['passed'],
        'credits': u['factoryCredits'], 'requests_est': users, 'model_tool_calls': len(model_calls), 'inner_calls': len(inner),
        'in': u['inputTokens'], 'cache_create': u['cacheCreationTokens'], 'cache_read': u['cacheReadTokens'], 'out': u['outputTokens'],
        'cache_read_share': round(u['cacheReadTokens'] / inp, 3), 'duration_ms': r['durationMs'], 'notif_types': dict(kinds)}))
