from inventory.cli import main


def test_text(capsys):
    main(["--min-qty", "100"])
    out = capsys.readouterr().out.splitlines()
    assert out == ["A-100  Bolt         250", "A-101  Nut          900"]
