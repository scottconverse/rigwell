---
name: visualize
description: Turn data, code structure or a process into a clear chart or diagram, delivered as a self-contained HTML or SVG file.
---
# Visualize

Create a visual that answers a specific question, then check that it reads clearly.

## Steps

1. **Pin down the question.** What should the viewer understand in five seconds? Pick the form to match: line chart for change over time, bars for comparison, scatter for relationships, a table when exact values matter, a flow or sequence diagram for process, a dependency graph or tree for structure.
2. **Get the data.** Read real data from files, command output or code rather than inventing numbers. For code structure, gather it with search (imports, call sites, folder layout). Keep only what supports the question.
3. **Build a single self-contained file**, usually HTML with inline SVG and a little inline JavaScript, or a plain SVG. Avoid external libraries and network requests unless the user wants them. Write it to a sensible path such as `docs/` or a temp folder, and tell the user the path.
4. **Design for reading.**
   - A title that states the finding, labeled axes with units, and direct labels instead of legends where possible.
   - Few colors, with enough contrast; do not rely on color alone to carry meaning.
   - Start bar charts at zero. Sort categories by value unless they have a natural order.
   - Work in light and dark backgrounds and at narrow widths (use viewBox and relative sizes).
   - Include a short caption saying where the data came from and its date.
5. **Verify.** Open the file's contents again, check the numbers against the source, and if a browser or screenshot tool is available, render it and look for overlapping labels or clipped text.

For diagrams in documentation, Mermaid text in a fenced code block is a good lightweight alternative when the target renders it.
