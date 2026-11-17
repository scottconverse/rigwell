# Per-request usage from cumulative session_token_usage_changed. Usage: python -I requests.py <runsDir> <id>...
import json, sys, os, statistics
K = ['inputTokens', 'outputTokens', 'cacheCreationTokens', 'cacheReadTokens', 'factoryCredits']
for rid in sys.argv[2:]:
    seen, prev, reqs = set(), {k: 0 for k in K}, []
    for l in open(os.path.join(sys.argv[1], rid, 'jsonrpc.jsonl'), encoding='utf-8'):
        m = json.loads(l)['m']
        if m.get('method') != 'droid.session_notification': continue
        n = m['params'].get('notification', m['params'])
        if n.get('type') != 'session_token_usage_changed': continue
        u = n['tokenUsage']; key = tuple(u[k] for k in K)
        if key in seen or u['factoryCredits'] == 0: continue
        seen.add(key); d = {k: u[k] - prev[k] for k in K}; prev = {k: u[k] for k in K}; reqs.append(d)
    side, main = reqs[0], reqs[1:]
    shares = [r['cacheReadTokens'] / max(1, r['inputTokens'] + r['cacheCreationTokens'] + r['cacheReadTokens']) for r in main]
    print(json.dumps({'id': rid, 'side_request_credits': side['factoryCredits'], 'main_requests': len(main),
                      'credits_per_request': [r['factoryCredits'] for r in main],
                      'cache_read_share_per_request': [round(s, 2) for s in shares],
                      'median_share': round(statistics.median(shares), 2)}))
