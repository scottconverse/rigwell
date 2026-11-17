from shop.pricing import calc_total


ITEMS = [7, 19, 48, 11, 17]


def total():
    return calc_total(ITEMS, discount=0.25)
