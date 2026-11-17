from shop.pricing import calc_total


ITEMS = [42, 34, 13, 26, 21]


def total():
    return calc_total(ITEMS, discount=0.25)
