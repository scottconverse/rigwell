from shop.pricing import calc_total


ITEMS = [40, 30, 10]


def total():
    return calc_total(ITEMS, discount=0.1)
