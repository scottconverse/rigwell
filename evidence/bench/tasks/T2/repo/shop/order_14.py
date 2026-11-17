from shop.pricing import calc_total, calc_total_tax


ITEMS = [42, 42, 9, 36, 12]


def total():
    return calc_total(ITEMS, discount=0.25)


def tax():
    return calc_total_tax(ITEMS, 0.08)
