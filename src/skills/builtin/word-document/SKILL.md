---
name: word-document
description: Create, read or edit Word (.docx) documents with proper headings, styles and tables, and verify the result.
---
# Word documents

A .docx file is a zip of XML parts. Use a library: python-docx (Python) or docx (JavaScript). For quick conversions, `pandoc` turns Markdown into .docx and back. Check what is installed first.

## Reading

- Extract text with python-docx by walking paragraphs (keep each paragraph's style name so headings stay visible) and tables (rows and cells). Or run `pandoc file.docx -t markdown` for a faithful text view.
- Comments, tracked changes and footnotes live in separate parts; if the user cares about them, unzip and read `word/comments.xml` and similar.

## Creating

1. Outline the document first: title, sections, and what each must say. Ask about audience and any template.
2. Use built-in styles (Title, Heading 1 to 3, List Bullet, List Number, Normal) instead of manual bold and font sizes, so the navigation pane, table of contents and accessibility tools work.
3. Set page size, margins and a single body font; make tables with a header row and sensible column widths; add captions to figures and alt text to images.
4. Put page numbers in the footer when the document is longer than a couple of pages. A table of contents field can be inserted but is only populated when the document is opened in Word; tell the user to update fields.

## Editing an existing document

- Work on a copy. Open it, find the paragraphs to change, and edit runs in place so formatting is kept. Replacing a paragraph's whole text resets mixed formatting inside it.
- Preserve headers, footers, styles and section settings. Do not reflow or restyle parts you were not asked to change.
- If the document uses tracked changes, say so before editing and do not silently accept or reject them.

## Verify

- Reopen the file and list headings and counts of paragraphs and tables.
- Convert to PDF (`soffice --headless --convert-to pdf`) and render a page or two to images to check layout, then fix and repeat.
- Report the output path and what changed.
