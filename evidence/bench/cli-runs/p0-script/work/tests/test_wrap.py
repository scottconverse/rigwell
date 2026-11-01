from textutils.wrap import wrap


def test_exact_fit():
    assert wrap("aaa bbb", 7) == ["aaa bbb"]


def test_simple():
    assert wrap("one two three four", 9) == ["one two", "three", "four"]
