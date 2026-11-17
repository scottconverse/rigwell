from shop.pricing import calc_total


ITEMS = [44, 17, 41]


def total():
    return calc_total(ITEMS, discount=0.0)
