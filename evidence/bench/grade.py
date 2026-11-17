# Hidden graders. Usage: python -I grade.py <tasksDir> <T> <workDir>  -> prints JSON {task, passed, detail}
import os, sys, json, subprocess, re, importlib, glob

TASKS, T, WORK = sys.argv[1], sys.argv[2], os.path.abspath(sys.argv[3])

def pytest_ok():
    p = subprocess.run([sys.executable, '-m', 'pytest', '-q', '-p', 'no:cacheprovider'], cwd=WORK,
                       capture_output=True, text=True, timeout=300)
    return p.returncode == 0, p.stdout[-400:]

def pyfiles():
    return [f for f in glob.glob(os.path.join(WORK, '**', '*.py'), recursive=True)]

def run_py(code):
    p = subprocess.run([sys.executable, '-c', code], cwd=WORK, capture_output=True, text=True, timeout=120)
    return p.returncode, p.stdout, p.stderr[-400:]

def g_T1():
    ans = json.load(open(os.path.join(TASKS, 'T1', 'answer.json')))
    f = os.path.join(WORK, 'report.json')
    if not os.path.exists(f):
        return False, 'no report.json'
    try:
        got = json.load(open(f, encoding='utf-8'))
    except Exception as e:
        return False, 'bad json: %s' % e
    ok = got.get('failed_count') == ans['failed_count'] and got.get('failed_jobs') == ans['failed_jobs']
    return ok, 'expected %d, got %r' % (ans['failed_count'], got.get('failed_count'))

def g_T2():
    texts = {f: open(f, encoding='utf-8').read() for f in pyfiles()}
    left = [os.path.relpath(f, WORK) for f, t in texts.items() if re.search(r'\bcalc_total\b', t)]
    if left:
        return False, 'calc_total still in %s' % left[:5]
    pr = texts.get(os.path.join(WORK, 'shop', 'pricing.py'), '')
    if 'def compute_order_total(' not in pr or 'def calc_total_tax(' not in pr:
        return False, 'pricing.py definitions wrong'
    code = ('import importlib,glob,os\n'
            'from shop.pricing import compute_order_total, calc_total_tax\n'
            'assert compute_order_total([10,20],discount=0.5)==15.0\n'
            'for f in sorted(glob.glob("shop/order_*.py")):\n'
            '    m=importlib.import_module("shop."+os.path.basename(f)[:-3]); m.total()\n'
            '    getattr(m,"tax",lambda:0)()\n'
            'print("ok")')
    rc, out, err = run_py(code)
    if rc != 0:
        return False, 'hidden check failed: ' + err
    ok, out = pytest_ok()
    return ok, 'pytest ' + ('ok' if ok else 'failed: ' + out)

def g_T3():
    t = open(os.path.join(TASKS, 'T3', 'repo', 'tests', 'test_wrap.py'), encoding='utf-8').read()
    if open(os.path.join(WORK, 'tests', 'test_wrap.py'), encoding='utf-8').read() != t:
        return False, 'tests were changed'
    code = ('from textutils.wrap import wrap\n'
            'assert wrap("aaa bbb",7)==["aaa bbb"]\n'
            'assert wrap("one two three four",9)==["one two","three","four"]\n'
            'assert wrap("a b c d",3)==["a b","c d"]\n'
            'assert wrap("supercalifragilistic is long",5)==["supercalifragilistic","is","long"]\n'
            'assert wrap("",4)==[]\n'
            'assert wrap("x  y",1)==["x","y"]\n'
            'print("ok")')
    rc, out, err = run_py(code)
    return rc == 0, 'hidden cases ' + ('ok' if rc == 0 else 'failed: ' + err)

def g_T4():
    ans = json.load(open(os.path.join(TASKS, 'T4', 'answer.json')))
    for name, text in ans['orig'].items():
        got = open(os.path.join(WORK, 'configs', name), encoding='utf-8').read()
        want = re.sub(r'(?m)^timeout_seconds = .*$', 'timeout_seconds = 30', text) if name in ans['bad'] else text
        if got.replace('\r\n', '\n') != want:
            return False, 'wrong content in %s' % name
    f = os.path.join(WORK, 'fixed.txt')
    if not os.path.exists(f):
        return False, 'no fixed.txt'
    lst = [l.strip() for l in open(f, encoding='utf-8').read().splitlines() if l.strip()]
    lst = [os.path.basename(x) for x in lst]
    return lst == ans['bad'], 'fixed.txt %s' % ('ok' if lst == ans['bad'] else 'wrong: %r' % lst[:5])

def g_T5():
    def cli(*a):
        p = subprocess.run([sys.executable, '-m', 'inventory.cli', *a], cwd=WORK, capture_output=True, text=True, timeout=60)
        return p.returncode, p.stdout
    rc, out = cli('--min-qty', '100')
    if rc or out.replace('\r\n', '\n') != 'A-100  Bolt         250\nA-101  Nut          900\n':
        return False, 'text output changed'
    rc, out = cli('--json')
    try:
        data = json.loads(out)
    except Exception:
        return False, 'json output not parseable'
    want = [{'sku': 'A-100', 'name': 'Bolt', 'qty': 250}, {'sku': 'A-101', 'name': 'Nut', 'qty': 900},
            {'sku': 'B-200', 'name': 'Bracket', 'qty': 40}, {'sku': 'C-310', 'name': 'Hinge', 'qty': 0}]
    if data != want:
        return False, 'json wrong: %r' % data
    rc, out = cli('--json', '--min-qty', '100')
    try:
        if json.loads(out) != want[:2]:
            return False, '--json ignores --min-qty'
    except Exception:
        return False, '--json with --min-qty not parseable'
    tests = ''.join(open(f, encoding='utf-8').read() for f in glob.glob(os.path.join(WORK, 'tests', '*.py')))
    if '--json' not in tests:
        return False, 'no test for --json'
    ok, out = pytest_ok()
    return ok, 'pytest ' + ('ok' if ok else 'failed: ' + out)

def g_T6():
    if not os.path.exists(os.path.join(WORK, 'blog', 'text.py')):
        return False, 'no blog/text.py'
    code = ('import blog.text, blog.utils\n'
            'assert blog.text.slugify("Hello, World!")=="hello-world"\n'
            'assert not hasattr(blog.utils,"slugify")\n'
            'assert blog.utils.word_count("a b")==2 and blog.utils.excerpt("a b c",2)=="a b..."\n'
            'from blog.feed import feed_entry; from blog.posts import make_post; from blog.tags import tag_slugs; from blog.urls import post_url\n'
            'assert feed_entry("Hi There","a b")["id"]=="hi-there" and post_url(2026,"New Post")=="/2026/new-post/"\n'
            'print("ok")')
    rc, out, err = run_py(code)
    if rc:
        return False, 'hidden check failed: ' + err
    bad = [os.path.relpath(f, WORK) for f in pyfiles() if re.search(r'blog\.utils import[^\n]*slugify|utils\.slugify', open(f, encoding='utf-8').read())]
    if bad:
        return False, 'old imports left in %s' % bad
    ok, out = pytest_ok()
    return ok, 'pytest ' + ('ok' if ok else 'failed: ' + out)

try:
    passed, detail = globals()['g_' + T]()
except Exception as e:
    passed, detail = False, 'grader error: %r' % e
print(json.dumps({'task': T, 'passed': bool(passed), 'detail': detail}))
