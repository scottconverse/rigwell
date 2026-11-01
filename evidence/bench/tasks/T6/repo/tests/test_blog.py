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
