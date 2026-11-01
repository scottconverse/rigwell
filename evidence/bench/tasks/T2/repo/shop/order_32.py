from shop.pricing import calc_total, calc_total_tax


ITEMS = [11, 29, 2]


def total():
    return calc_total(ITEMS, discount=0.0)


def tax():
    return calc_total_tax(ITEMS, 0.08)
