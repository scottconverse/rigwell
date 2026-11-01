import argparse

from inventory.data import ITEMS


def main(argv=None):
    parser = argparse.ArgumentParser(prog="inventory")
    parser.add_argument("--min-qty", type=int, default=0)
    args = parser.parse_args(argv)
    for sku, name, qty in ITEMS:
        if qty >= args.min_qty:
            print(f"{sku}  {name:<10} {qty:>5}")


if __name__ == "__main__":
    main()
