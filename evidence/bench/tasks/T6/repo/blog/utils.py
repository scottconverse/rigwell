import re


def slugify(title):
    """Lowercase, replace runs of non-alphanumerics with one hyphen, trim hyphens."""
    return re.sub(r"[^a-z0-9]+", "-", title.lower()).strip("-")


def word_count(text):
    return len(text.split())


def excerpt(text, n=20):
    words = text.split()
    return " ".join(words[:n]) + ("..." if len(words) > n else "")
