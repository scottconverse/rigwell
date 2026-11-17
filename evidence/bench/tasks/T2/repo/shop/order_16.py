from shop.pricing import calc_total


ITEMS = [9, 2, 32, 7, 13]


def total():
    return calc_total(ITEMS, discount=0.1)
