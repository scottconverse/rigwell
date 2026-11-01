# Second-pass checks: list-tools output, TUI events and visible screen text, compaction log lines.
import json, glob, os, re
O = '/home/cap/out'
for f in sorted(glob.glob(O + '/L-*.stdout.txt')):
    try:
        d = json.load(open(f))
    except Exception as e:
        print(f, 'not json', e); continue
    items = d if isinstance(d, list) else (d.get('tools') or d.get('result') or d)
    names = []
    if isinstance(items, list):
        for t in items:
            names.append(t.get('id') or t.get('name') if isinstance(t, dict) else str(t))
    else:
        names = list(items.keys()) if isinstance(items, dict) else [str(items)[:200]]
    print(os.path.basename(f), len(names), names)
for n in ('E1', 'E2'):
    print('==', n, 'events'); print(open(O + '/%s.events.txt' % n).read())
    raw = open(O + '/%s.screen.txt' % n, 'rb').read().decode('utf-8', 'replace')
    txt = re.sub(r'\x1b\[[0-9;?<>=]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(\x07|\x1b\\)|\x1b[()][A-Z0-9]|\x1b[=>78]', '', raw)
    lines = [l.strip() for l in re.split(r'[\r\n]+', txt) if l.strip()]
    seen = []
    for l in lines:
        if l not in seen[-40:]:
            seen.append(l)
    print('-- %s screen lines (deduped, last 45 of %d):' % (n, len(seen)))
    for l in seen[-45:]:
        print('   ', l[:160])
for f in sorted(glob.glob(O + '/*-logs/*')):
    for line in open(f, errors='replace'):
        if re.search(r'\[Compaction\]|compact', line, re.I):
            print(os.path.relpath(f, O), line.strip()[:300])
