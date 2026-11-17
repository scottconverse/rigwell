from shop.pricing import calc_total


ITEMS = [16, 36, 23, 23]


def total():
    return calc_total(ITEMS, discount=0.1)
