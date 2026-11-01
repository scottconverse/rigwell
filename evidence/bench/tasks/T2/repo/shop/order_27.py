from shop.pricing import calc_total


ITEMS = [8, 40, 45, 18]


def total():
    return calc_total(ITEMS, discount=0.25)
