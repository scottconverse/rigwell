from blog import utils


def feed_entry(title, body):
    return {"id": utils.slugify(title), "summary": utils.excerpt(body, 10)}
