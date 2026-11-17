from shop.pricing import calc_total


ITEMS = [50, 16, 23, 50]


def total():
    return calc_total(ITEMS, discount=0.1)
