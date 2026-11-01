from shop.pricing import calc_total, calc_total_tax


ITEMS = [41, 45]


def total():
    return calc_total(ITEMS, discount=0.25)


def tax():
    return calc_total_tax(ITEMS, 0.08)
