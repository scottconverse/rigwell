from shop.pricing import calc_total


ITEMS = [32, 24, 20, 10, 16]


def total():
    return calc_total(ITEMS, discount=0.1)
