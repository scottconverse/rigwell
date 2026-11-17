from shop.pricing import calc_total


ITEMS = [10, 47, 26]


def total():
    return calc_total(ITEMS, discount=0.0)
