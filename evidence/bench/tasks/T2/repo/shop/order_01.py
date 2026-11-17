from shop.pricing import calc_total


ITEMS = [3, 34, 21, 13, 16]


def total():
    return calc_total(ITEMS, discount=0.1)
