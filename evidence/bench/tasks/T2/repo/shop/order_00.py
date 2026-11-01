from shop.pricing import calc_total


ITEMS = [13, 13, 44, 26, 4]


def total():
    return calc_total(ITEMS, discount=0.25)
