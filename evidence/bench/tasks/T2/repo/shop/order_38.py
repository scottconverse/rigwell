from shop.pricing import calc_total


ITEMS = [17, 49, 43, 43]


def total():
    return calc_total(ITEMS, discount=0.0)
