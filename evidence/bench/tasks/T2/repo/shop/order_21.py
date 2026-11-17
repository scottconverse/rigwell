from shop.pricing import calc_total, calc_total_tax


ITEMS = [31, 40, 15]


def total():
    return calc_total(ITEMS, discount=0.0)


def tax():
    return calc_total_tax(ITEMS, 0.08)
