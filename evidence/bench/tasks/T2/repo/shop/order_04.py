from shop.pricing import calc_total


ITEMS = [32, 18, 3]


def total():
    return calc_total(ITEMS, discount=0.1)
