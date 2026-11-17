import importlib

MODS = ['order_00', 'order_01', 'order_02', 'order_03', 'order_04', 'order_05', 'order_06', 'order_07', 'order_08', 'order_09', 'order_10', 'order_11', 'order_12', 'order_13', 'order_14', 'order_15', 'order_16', 'order_17', 'order_18', 'order_19', 'order_20', 'order_21', 'order_22', 'order_23', 'order_24', 'order_25', 'order_26', 'order_27', 'order_28', 'order_29', 'order_30', 'order_31', 'order_32', 'order_33', 'order_34', 'order_35', 'order_36', 'order_37', 'order_38', 'order_39']


def test_all_orders_total():
    for m in MODS:
        assert importlib.import_module("shop." + m).total() >= 0
