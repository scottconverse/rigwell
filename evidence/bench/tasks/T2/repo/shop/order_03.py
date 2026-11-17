from shop.pricing import calc_total


ITEMS = [48, 46, 46, 43, 3]


def total():
    return calc_total(ITEMS, discount=0.0)
