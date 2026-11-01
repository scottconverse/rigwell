from blog.utils import slugify, word_count


def make_post(title, body):
    return {"slug": slugify(title), "title": title, "words": word_count(body)}
