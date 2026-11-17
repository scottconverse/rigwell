from shop.pricing import calc_total, calc_total_tax


ITEMS = [13, 34, 44, 44, 6]


def total():
    return calc_total(ITEMS, discount=0.1)


def tax():
    return calc_total_tax(ITEMS, 0.08)
