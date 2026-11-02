---
name: powerpoint
description: Create or edit PowerPoint (.pptx) slide decks with a clear structure, consistent layout and verified output.
---
# PowerPoint decks

A .pptx file is a zip of XML parts. Use a library rather than editing the XML by hand: python-pptx (Python) or pptxgenjs (JavaScript). Check what is installed first; install into a virtual environment or temp folder if needed.

## Plan the deck before building

1. Ask for or infer the audience, the goal, the length and any template or brand colors. If the user supplied a .pptx template, open it and build from its layouts so styling carries over.
2. Write an outline: one sentence per slide stating the point, not just a topic. Aim for one idea per slide.
3. Decide for each slide what supports the point: a short list, a chart, a table, a diagram or an image.

## Build

- Use the template's layouts and placeholders (title, body) so outline view and accessibility work. Avoid free-floating text boxes where a placeholder exists.
- Keep text short: a title, then at most about five bullets of a dozen words or fewer. Body text no smaller than 18 pt.
- Use native charts and tables from the library instead of pasted pictures, so the user can edit the data.
- Choose two fonts at most and a small color palette; keep strong contrast.
- Add alt text to images, and put detail that does not fit into the speaker notes.
- Keep a consistent margin, alignment and slide number or footer.

## Edit an existing deck

Read it first and list each slide's layout and text. Change only what was asked, preserve layouts and masters, and avoid reflowing slides you were not asked to touch.

## Verify

- Reopen the saved file and list the slides and their titles.
- Render to images (for example `soffice --headless --convert-to pdf`, then `pdftoppm -png`) and look for overflow, overlapping shapes and unreadable text. Fix and render again.
- Save as a new file name unless the user asked you to overwrite, and report the path and slide count.
