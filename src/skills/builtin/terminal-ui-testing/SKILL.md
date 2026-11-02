---
name: terminal-ui-testing
description: Drive and test an interactive terminal (TUI) program by running it in a detached terminal session, sending keys and reading the screen.
---
# Testing terminal user interfaces

Interactive programs cannot be tested by piping text into them, because they draw to a screen and read raw key presses. Run them inside a detached terminal multiplexer so you can send keys and capture what is on screen.

## Setup

Check that `tmux` is available (`command -v tmux`). If it is not, tell the user and suggest installing it, or fall back to a pseudo-terminal test library for the project's language.

Pick a session name and a fixed size so output is predictable:

```
tmux new-session -d -s tuitest -x 100 -y 30 'cd /path/to/project && ./your-program'
```

## The loop

1. **Wait for the first frame.** Poll the screen instead of sleeping a fixed time: capture, check for an expected string, retry a few times with short delays, give up after a timeout.
2. **Read the screen**: `tmux capture-pane -t tuitest -p` prints the visible text. Add `-e` to keep color codes when styling matters, and `-S -200` to include scrollback.
3. **Send input**: `tmux send-keys -t tuitest 'hello' Enter`. Named keys include `Enter`, `Escape`, `Tab`, `Up`, `Down`, `C-c`. Use `-l` to send literal text without key-name interpretation.
4. **Assert**: after each action, capture and check for the expected text or absence of an error. Save captures as evidence when something fails.
5. **Resize** with `tmux resize-window -t tuitest -x 60 -y 20` to test narrow layouts.

## Cleanup and safety

- Always end with `tmux kill-session -t tuitest`, even after failures.
- Run against temporary data and a temporary home directory, never real user data.
- Do not send destructive input to programs that act on real systems.

## Reporting

Report each scenario as: steps taken, expected screen, actual screen (quote the relevant lines), pass or fail. When you find a bug, include the smallest key sequence that reproduces it.
