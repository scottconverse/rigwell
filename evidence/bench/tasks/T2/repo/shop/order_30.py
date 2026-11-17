from shop.pricing import calc_total


ITEMS = [48, 40, 38, 14]


def total():
    return calc_total(ITEMS, discount=0.1)
