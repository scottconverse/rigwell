# Build the 6 benchmark task repos (deterministic). Usage: python -I gen_tasks.py <outDir>
# Each task: <out>/<T>/repo (copied fresh per run) and <out>/<T>/prompt.txt. Graders live in grade.py.
import os, sys, random, json, shutil, textwrap

OUT = sys.argv[1]

def w(path, text):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, 'w', newline='\n', encoding='utf-8') as f:
        f.write(textwrap.dedent(text).lstrip('\n') if text.startswith('\n') else text)

def task(name, prompt):
    d = os.path.join(OUT, name)
    if os.path.exists(d):
        shutil.rmtree(d)
    os.makedirs(os.path.join(d, 'repo'))
    w(os.path.join(d, 'prompt.txt'), prompt.strip() + '\n')
    return os.path.join(d, 'repo')

# ---------- T1: CI log triage, 300 logs, last STATUS line decides ----------
r = random.Random(101)
repo = task('T1', """
The logs/ folder holds 300 CI job logs. A job's result is the LAST line in its file that starts with
"STATUS:". Earlier STATUS lines are from retries and do not count. Write report.json in the repository
root with exactly this shape: {"failed_count": <int>, "failed_jobs": [<job ids, sorted ascending>]}.
A job id is the file name without ".log". Do not change the logs.
""")
answer = []
for i in range(300):
    jid = 'job-%03d' % i
    lines = ['job %s started on runner-%d' % (jid, r.randint(1, 9))]
    for k in range(r.randint(5, 25)):
        lines.append('step %d: %s' % (k, r.choice(['compile ok', 'lint ok', 'cache hit', 'download 12MB',
                                                     'warning: FAILED to fetch optional mirror, using default',
                                                     'tests: 41 passed'])))
    attempts = r.choice([1, 1, 1, 2, 3])
    final = None
    for a in range(attempts):
        final = r.random() < 0.18
        lines.append('STATUS: %s' % ('FAILED' if final else 'PASSED'))
        if a < attempts - 1:
            lines.append('retrying (attempt %d)' % (a + 2))
    lines.append('summary: see artifacts')
    if final:
        answer.append(jid)
    w(os.path.join(repo, 'logs', jid + '.log'), '\n'.join(lines) + '\n')
w(os.path.join(OUT, 'T1', 'answer.json'), json.dumps({'failed_count': len(answer), 'failed_jobs': sorted(answer)}))

# ---------- T2: rename calc_total -> compute_order_total across ~40 files ----------
r = random.Random(202)
repo = task('T2', """
Rename the function calc_total in shop/pricing.py to compute_order_total, and update every use of it
in the repository (including tests). Do not rename calc_total_tax or anything else. When you are done,
`python -m pytest -q` must pass.
""")
w(os.path.join(repo, 'shop', '__init__.py'), '')
w(os.path.join(repo, 'shop', 'pricing.py'), '''
def calc_total(prices, discount=0.0):
    """Sum prices and apply a fractional discount."""
    return round(sum(prices) * (1 - discount), 2)


def calc_total_tax(prices, rate):
    """Tax owed on the undiscounted total."""
    return round(sum(prices) * rate, 2)
''')
mods = []
for i in range(40):
    m = 'order_%02d' % i
    mods.append(m)
    k = r.randint(2, 5); disc = r.choice([0.0, 0.1, 0.25])
    uses_tax = r.random() < 0.4
    body = 'from shop.pricing import calc_total%s\n\n\n' % (', calc_total_tax' if uses_tax else '')
    body += 'ITEMS = %r\n\n\n' % [r.randint(1, 50) for _ in range(k)]
    body += 'def total():\n    return calc_total(ITEMS, discount=%r)\n' % disc
    if uses_tax:
        body += '\n\ndef tax():\n    return calc_total_tax(ITEMS, 0.08)\n'
    w(os.path.join(repo, 'shop', m + '.py'), body)
w(os.path.join(repo, 'tests', 'test_pricing.py'), '''
from shop.pricing import calc_total, calc_total_tax


def test_total():
    assert calc_total([10, 20], discount=0.5) == 15.0


def test_tax():
    assert calc_total_tax([100], 0.08) == 8.0
''')
w(os.path.join(repo, 'tests', 'test_orders.py'),
  'import importlib\n\nMODS = %r\n\n\ndef test_all_orders_total():\n'
  '    for m in MODS:\n        assert importlib.import_module("shop." + m).total() >= 0\n' % mods)
w(os.path.join(repo, 'pytest.ini'), '[pytest]\npythonpath = .\n')

# ---------- T3: single bug, failing test shows it ----------
repo = task('T3', """
tests/test_wrap.py fails. Find and fix the bug in textutils/wrap.py so the tests pass. Do not change the tests.
""")
w(os.path.join(repo, 'textutils', '__init__.py'), '')
w(os.path.join(repo, 'textutils', 'wrap.py'), '''
def wrap(text, width):
    """Greedy word wrap. Each returned line is at most `width` characters, unless a single word is
    longer than `width`, in which case that word sits on its own line."""
    lines, current = [], ""
    for word in text.split():
        if not current:
            current = word
        elif len(current) + 1 + len(word) < width:
            current += " " + word
        else:
            lines.append(current)
            current = word
    if current:
        lines.append(current)
    return lines
''')
w(os.path.join(repo, 'tests', 'test_wrap.py'), '''
from textutils.wrap import wrap


def test_exact_fit():
    assert wrap("aaa bbb", 7) == ["aaa bbb"]


def test_simple():
    assert wrap("one two three four", 9) == ["one two", "three", "four"]
''')
w(os.path.join(repo, 'pytest.ini'), '[pytest]\npythonpath = .\n')

# ---------- T4: fix bad timeout values in 150 ini files ----------
r = random.Random(404)
repo = task('T4', """
configs/ holds 150 service config files. In each, the line `timeout_seconds = <value>` must be a whole
number from 1 to 3600. Where the value breaks that rule (negative, zero, too large, or not a whole
number), set it to 30. Change nothing else in any file. Then write fixed.txt in the repository root
listing the names of the files you changed, one per line, sorted.
""")
bad = []; orig = {}
for i in range(150):
    name = 'service-%03d.ini' % i
    roll = r.random()
    if roll < 0.12:
        v = r.choice(['-5', '0', '99999', '12.5', 'abc', '3601']); bad.append(name)
    else:
        v = str(r.randint(1, 3600))
    text = '[service]\nname = svc%03d\nport = %d\ntimeout_seconds = %s\nretries = %d\n# max timeout_seconds is 3600\n' % (
        i, 8000 + i, v, r.randint(0, 5))
    orig[name] = text
    w(os.path.join(repo, 'configs', name), text)
w(os.path.join(OUT, 'T4', 'answer.json'), json.dumps({'bad': sorted(bad), 'orig': orig}))

# ---------- T5: add --json option to a small CLI, with a test ----------
repo = task('T5', """
Add a --json option to `python -m inventory.cli`. With --json it prints the items as a JSON list of
objects with keys "sku", "name" and "qty" (qty as an integer), in the same order as the text output,
and nothing else. Without --json, output must stay exactly as it is now. Add a test for --json under tests/.
`python -m pytest -q` must pass.
""")
w(os.path.join(repo, 'inventory', '__init__.py'), '')
w(os.path.join(repo, 'inventory', 'data.py'), '''
ITEMS = [
    ("A-100", "Bolt", 250),
    ("A-101", "Nut", 900),
    ("B-200", "Bracket", 40),
    ("C-310", "Hinge", 0),
]
''')
w(os.path.join(repo, 'inventory', 'cli.py'), '''
import argparse

from inventory.data import ITEMS


def main(argv=None):
    parser = argparse.ArgumentParser(prog="inventory")
    parser.add_argument("--min-qty", type=int, default=0)
    args = parser.parse_args(argv)
    for sku, name, qty in ITEMS:
        if qty >= args.min_qty:
            print(f"{sku}  {name:<10} {qty:>5}")


if __name__ == "__main__":
    main()
''')
w(os.path.join(repo, 'tests', 'test_cli.py'), '''
from inventory.cli import main


def test_text(capsys):
    main(["--min-qty", "100"])
    out = capsys.readouterr().out.splitlines()
    assert out == ["A-100  Bolt         250", "A-101  Nut          900"]
''')
w(os.path.join(repo, 'pytest.ini'), '[pytest]\npythonpath = .\n')

# ---------- T6: move slugify into blog/text.py ----------
repo = task('T6', """
Move the slugify function out of blog/utils.py into a new module blog/text.py. Remove it from
blog/utils.py (keep the other functions there) and update every import in the repository to use
blog.text. `python -m pytest -q` must pass.
""")
w(os.path.join(repo, 'blog', '__init__.py'), '')
w(os.path.join(repo, 'blog', 'utils.py'), '''
import re


def slugify(title):
    """Lowercase, replace runs of non-alphanumerics with one hyphen, trim hyphens."""
    return re.sub(r"[^a-z0-9]+", "-", title.lower()).strip("-")


def word_count(text):
    return len(text.split())


def excerpt(text, n=20):
    words = text.split()
    return " ".join(words[:n]) + ("..." if len(words) > n else "")
''')
w(os.path.join(repo, 'blog', 'posts.py'), '''
from blog.utils import slugify, word_count


def make_post(title, body):
    return {"slug": slugify(title), "title": title, "words": word_count(body)}
''')
w(os.path.join(repo, 'blog', 'tags.py'), '''
from blog.utils import slugify


def tag_slugs(tags):
    return sorted({slugify(t) for t in tags})
''')
w(os.path.join(repo, 'blog', 'feed.py'), '''
from blog import utils


def feed_entry(title, body):
    return {"id": utils.slugify(title), "summary": utils.excerpt(body, 10)}
''')
w(os.path.join(repo, 'blog', 'urls.py'), '''
from blog.utils import slugify as _slug


def post_url(year, title):
    return f"/{year}/{_slug(title)}/"
''')
w(os.path.join(repo, 'tests', 'test_blog.py'), '''
from blog.feed import feed_entry
from blog.posts import make_post
from blog.tags import tag_slugs
from blog.urls import post_url
from blog.utils import slugify


def test_slugify():
    assert slugify("Hello, World!") == "hello-world"


def test_modules():
    assert make_post("A B", "x y z")["slug"] == "a-b"
    assert tag_slugs(["Py Thon", "py-thon"]) == ["py-thon"]
    assert post_url(2026, "New Post") == "/2026/new-post/"
    assert feed_entry("Hi There", "a b")["id"] == "hi-there"
''')
w(os.path.join(repo, 'pytest.ini'), '[pytest]\npythonpath = .\n')
print('ok', OUT)
