from shop.pricing import calc_total


ITEMS = [1, 12, 23, 47, 42]


def total():
    return calc_total(ITEMS, discount=0.0)
