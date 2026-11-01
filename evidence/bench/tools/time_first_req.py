# Claim D (offline): time from `droid exec` process start to the first request reaching the mock.
# Usage: python -I time_first_req.py <droid.exe> <mockHome> <reqDir> <workDir> <n>
import os, sys, json, glob, subprocess, time
from datetime import datetime, timezone
exe, home, reqdir, work, n = sys.argv[1:6]
env = dict(os.environ, FACTORY_HOME_OVERRIDE=home, HOME=home, USERPROFILE=home, FACTORY_AIRGAP_ENABLED='1',
           FACTORY_DISABLE_KEYRING='1', FACTORY_DROID_AUTO_UPDATE_ENABLED='false', OTEL_SDK_DISABLED='true')
os.makedirs(work, exist_ok=True)
res = []
for i in range(int(n)):
    before = set(glob.glob(os.path.join(reqdir, 'req-*.json')))
    t0 = datetime.now(timezone.utc)
    p = subprocess.run([exe, 'exec', '-m', 'custom:mock-0', '-o', 'json', 'say hi'], cwd=work, env=env,
                       capture_output=True, text=True, timeout=120)
    new = sorted(set(glob.glob(os.path.join(reqdir, 'req-*.json'))) - before)
    times = [datetime.fromisoformat(json.load(open(f, encoding='utf-8'))['time']) for f in new]
    first = (min(times) - t0).total_seconds() * 1000 if times else None
    try: dur = json.loads(p.stdout.strip().splitlines()[-1]).get('duration_ms')
    except Exception: dur = None
    res.append({'run': i + 1, 'first_request_ms': round(first) if first else None, 'requests': len(new), 'rc': p.returncode, 'duration_ms': dur})
    print(json.dumps(res[-1]), flush=True)
vals = sorted(r['first_request_ms'] for r in res if r['first_request_ms'])
print(json.dumps({'n': len(vals), 'median_ms': vals[len(vals)//2] if len(vals) % 2 else (vals[len(vals)//2-1]+vals[len(vals)//2])/2, 'min': vals[0], 'max': vals[-1]}))
