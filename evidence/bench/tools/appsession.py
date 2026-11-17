# Summarize one app session: assistant turns, tool calls, wall time, settings usage.
# Usage: python -I appsession.py <session.jsonl>
import json, sys, datetime
f = sys.argv[1]
rows = [json.loads(l) for l in open(f, encoding='utf-8') if l.strip()]
ts = lambda s: datetime.datetime.fromisoformat(s.replace('Z', '+00:00'))
msgs = [r for r in rows if r.get('type') == 'message']
asst = [r for r in msgs if r['message'].get('role') == 'assistant']
tools = {}
for r in asst:
    c = r['message'].get('content') or []
    names = [b.get('name') for b in c if isinstance(b, dict) and b.get('type') == 'tool_use']
    for n in names: tools[n] = tools.get(n, 0) + 1
    print(r['timestamp'], 'assistant', names or [b.get('type') for b in c if isinstance(b, dict)])
print('assistant messages:', len(asst), 'tool calls:', tools)
print('first->last message seconds:', (ts(msgs[-1]['timestamp']) - ts(msgs[0]['timestamp'])).total_seconds())
s = json.load(open(f.replace('.jsonl', '.settings.json'), encoding='utf-8'))
print('model:', s.get('model'), '| router:', (s.get('effectiveFactoryRouterModel') or {}).get('modelId'),
      (s.get('effectiveFactoryRouterModel') or {}).get('reasoningEffort'), '| mode:', s.get('toolExecutionMode'),
      '| provider:', s.get('apiProviderLock'), '| active ms:', s.get('assistantActiveTimeMs'))
print('usage:', s.get('tokenUsage'))
