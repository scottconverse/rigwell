from shop.pricing import calc_total


ITEMS = [35, 48, 50]


def total():
    return calc_total(ITEMS, discount=0.0)
