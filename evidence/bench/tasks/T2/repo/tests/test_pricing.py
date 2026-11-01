from shop.pricing import calc_total, calc_total_tax


def test_total():
    assert calc_total([10, 20], discount=0.5) == 15.0


def test_tax():
    assert calc_total_tax([100], 0.08) == 8.0
