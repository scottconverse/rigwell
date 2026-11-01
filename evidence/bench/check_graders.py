# Check each grader fails on the untouched repo and passes on a reference solution.
# Usage: python -I check_graders.py <benchDir>
import os, sys, json, shutil, subprocess, re, glob

B = sys.argv[1]; TASKS = os.path.join(B, 'tasks'); TMP = os.path.join(B, 'gradecheck')

def grade(t, work):
    p = subprocess.run([sys.executable, '-I', os.path.join(B, 'grade.py'), TASKS, t, work], capture_output=True, text=True)
    return json.loads(p.stdout.strip().splitlines()[-1])

def fresh(t, tag):
    d = os.path.join(TMP, t + '-' + tag)
    if os.path.exists(d): shutil.rmtree(d)
    shutil.copytree(os.path.join(TASKS, t, 'repo'), d); return d

def sub(path, a, b, regex=False):
    s = open(path, encoding='utf-8').read()
    s = re.sub(a, b, s) if regex else s.replace(a, b)
    open(path, 'w', encoding='utf-8', newline='\n').write(s)

def ref(t, d):
    if t == 'T1':
        failed = []
        for f in glob.glob(os.path.join(d, 'logs', '*.log')):
            st = [l for l in open(f).read().splitlines() if l.startswith('STATUS:')]
            if st[-1].endswith('FAILED'): failed.append(os.path.basename(f)[:-4])
        json.dump({'failed_count': len(failed), 'failed_jobs': sorted(failed)}, open(os.path.join(d, 'report.json'), 'w'))
    elif t == 'T2':
        for f in glob.glob(os.path.join(d, '**', '*.py'), recursive=True):
            sub(f, r'\bcalc_total\b', 'compute_order_total', regex=True)
    elif t == 'T3':
        sub(os.path.join(d, 'textutils', 'wrap.py'), '< width', '<= width')
    elif t == 'T4':
        fixed = []
        for f in sorted(glob.glob(os.path.join(d, 'configs', '*.ini'))):
            s = open(f).read(); v = re.search(r'(?m)^timeout_seconds = (.*)$', s).group(1)
            if not (v.isdigit() and 1 <= int(v) <= 3600):
                sub(f, r'(?m)^timeout_seconds = .*$', 'timeout_seconds = 30', regex=True); fixed.append(os.path.basename(f))
        open(os.path.join(d, 'fixed.txt'), 'w').write('\n'.join(fixed) + '\n')
    elif t == 'T5':
        sub(os.path.join(d, 'inventory', 'cli.py'), 'import argparse', 'import argparse\nimport json')
        sub(os.path.join(d, 'inventory', 'cli.py'), '    args = parser.parse_args(argv)\n',
            '    parser.add_argument("--json", action="store_true")\n    args = parser.parse_args(argv)\n'
            '    if args.json:\n        print(json.dumps([{"sku": s, "name": n, "qty": q} for s, n, q in ITEMS if q >= args.min_qty]))\n        return\n')
        open(os.path.join(d, 'tests', 'test_json.py'), 'w').write(
            'import json\nfrom inventory.cli import main\n\ndef test_json(capsys):\n    main(["--json"])\n'
            '    assert len(json.loads(capsys.readouterr().out)) == 4\n')
    elif t == 'T6':
        u = os.path.join(d, 'blog', 'utils.py'); s = open(u).read()
        fn = re.search(r'def slugify.*?\n\n\n', s, re.S).group(0)
        open(os.path.join(d, 'blog', 'text.py'), 'w').write('import re\n\n\n' + fn.rstrip() + '\n')
        open(u, 'w').write(s.replace(fn, ''))
        sub(os.path.join(d, 'blog', 'posts.py'), 'from blog.utils import slugify, word_count', 'from blog.text import slugify\nfrom blog.utils import word_count')
        sub(os.path.join(d, 'blog', 'tags.py'), 'from blog.utils import slugify', 'from blog.text import slugify')
        sub(os.path.join(d, 'blog', 'feed.py'), 'from blog import utils', 'from blog import text, utils')
        sub(os.path.join(d, 'blog', 'feed.py'), 'utils.slugify', 'text.slugify')
        sub(os.path.join(d, 'blog', 'urls.py'), 'from blog.utils import', 'from blog.text import')
        sub(os.path.join(d, 'tests', 'test_blog.py'), 'from blog.utils import slugify', 'from blog.text import slugify')

for t in ['T1', 'T2', 'T3', 'T4', 'T5', 'T6']:
    a = grade(t, fresh(t, 'untouched'))
    d = fresh(t, 'ref'); ref(t, d); b = grade(t, d)
    print(t, 'untouched:', a['passed'], '|', a['detail'][:70], '|| reference:', b['passed'], '|', b['detail'][:70])
shutil.rmtree(TMP)
