from shop.pricing import calc_total


ITEMS = [3, 35, 17]


def total():
    return calc_total(ITEMS, discount=0.1)
