from shop.pricing import calc_total, calc_total_tax


ITEMS = [42, 15, 43, 31, 39]


def total():
    return calc_total(ITEMS, discount=0.1)


def tax():
    return calc_total_tax(ITEMS, 0.08)
