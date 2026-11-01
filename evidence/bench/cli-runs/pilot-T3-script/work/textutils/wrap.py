def wrap(text, width):
    """Greedy word wrap. Each returned line is at most `width` characters, unless a single word is
    longer than `width`, in which case that word sits on its own line."""
    lines, current = [], ""
    for word in text.split():
        if not current:
            current = word
        elif len(current) + 1 + len(word) <= width:
            current += " " + word
        else:
            lines.append(current)
            current = word
    if current:
        lines.append(current)
    return lines
