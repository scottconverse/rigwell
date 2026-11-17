from shop.pricing import calc_total


ITEMS = [1, 6]


def total():
    return calc_total(ITEMS, discount=0.0)
