from shop.pricing import calc_total, calc_total_tax


ITEMS = [5, 25, 4, 43, 37]


def total():
    return calc_total(ITEMS, discount=0.1)


def tax():
    return calc_total_tax(ITEMS, 0.08)
