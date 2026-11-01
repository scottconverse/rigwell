from shop.pricing import calc_total


ITEMS = [13, 31]


def total():
    return calc_total(ITEMS, discount=0.25)
