from shop.pricing import calc_total


ITEMS = [9, 19, 17, 36, 28]


def total():
    return calc_total(ITEMS, discount=0.1)
