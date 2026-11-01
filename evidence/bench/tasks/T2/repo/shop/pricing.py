def calc_total(prices, discount=0.0):
    """Sum prices and apply a fractional discount."""
    return round(sum(prices) * (1 - discount), 2)


def calc_total_tax(prices, rate):
    """Tax owed on the undiscounted total."""
    return round(sum(prices) * rate, 2)
