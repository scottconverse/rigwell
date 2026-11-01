from shop.pricing import calc_total


ITEMS = [45, 42, 13, 28]


def total():
    return calc_total(ITEMS, discount=0.0)
