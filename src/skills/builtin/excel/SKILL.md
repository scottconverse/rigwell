---
name: excel
description: Read, analyze, create or edit Excel (.xlsx) and CSV spreadsheets with working formulas, clean formatting and verified results.
---
# Excel spreadsheets

Use openpyxl for building or editing .xlsx files with formulas and formatting, and pandas for reading and analyzing tables. Check what is installed first. CSV needs no library.

## Reading and analyzing

1. List the sheets and the used range of each before reading anything in depth. Look at the first rows to find the real header row; many sheets have titles above it.
2. Load with pandas (`read_excel(path, sheet_name=..., header=...)`). Check types, blanks, duplicates and obviously wrong values before computing.
3. Note that openpyxl with `data_only=True` returns the last cached formula results, which are empty if the file was never opened in a spreadsheet program.
4. Report numbers with the method used (filter, grouping, formula) so the user can check them.

## Creating and editing

- Keep inputs, calculations and outputs on clear, labeled areas or separate sheets. Put assumptions in labeled cells instead of burying constants in formulas.
- Write real formulas (`=SUM(B2:B20)`) rather than pasted results when the user will change the data. Use absolute references where a cell must not move when copied.
- Format for reading: a bold frozen header row, number formats for currency, percent and dates, sensible column widths, and consistent alignment.
- Add data validation or notes only where they help.
- When editing an existing workbook, preserve what you do not touch: other sheets, defined names, styles. Note that openpyxl drops some features (charts and pivot tables from other tools, macros unless `keep_vba=True`); warn the user if the file has them and work on a copy.

## Verify

- Recalculate by converting with `soffice --headless --convert-to xlsx` (or `csv`) and read the results back; check totals against an independent calculation in code.
- Scan for error values (`#REF!`, `#DIV/0!`, `#NAME?`) and formulas pointing at empty cells.
- Save to a new file unless told otherwise and report the path, the sheets and what each contains.
