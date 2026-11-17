from blog.utils import slugify


def tag_slugs(tags):
    return sorted({slugify(t) for t in tags})
