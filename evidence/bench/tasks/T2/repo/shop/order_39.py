from shop.pricing import calc_total


ITEMS = [23, 29, 41]


def total():
    return calc_total(ITEMS, discount=0.1)
