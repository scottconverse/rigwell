from shop.pricing import calc_total, calc_total_tax


ITEMS = [36, 8, 17, 16, 41]


def total():
    return calc_total(ITEMS, discount=0.1)


def tax():
    return calc_total_tax(ITEMS, 0.08)
