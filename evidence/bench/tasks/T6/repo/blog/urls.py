from blog.utils import slugify as _slug


def post_url(year, title):
    return f"/{year}/{_slug(title)}/"
