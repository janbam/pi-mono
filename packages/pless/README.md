# pless

A terminal pager for Markdown files, built on the same renderer pi's coding agent uses for assistant messages. Headings, tables, fenced code with syntax highlighting hooks, blockquotes, lists, LaTeX math, and OSC 8 hyperlinks all render exactly as they do in `pi`.

## Usage

```bash
pless README.md
pless docs/*.md          # multiple files, switch with :n and :p
```

Requires a TTY on stdin (it is an interactive pager; stdin piping is intentionally not supported).

## Keys

| Key | Action |
| --- | --- |
| `j` / `down`, `k` / `up` | Scroll one line down / up |
| `space`, `f`, `pgdn`, `ctrl+d` | Half or full page forward |
| `b`, `pgup`, `ctrl+u` | Half or full page back |
| `g` / `home`, `G` / `end` | Jump to top / bottom |
| `/` | Open search overlay (`enter`/`n` next match, `shift+enter`/`N` previous, `esc` close) |
| `:` then `n` | Next file (`:p` previous) |
| `q`, `ctrl+c` | Quit |

Mouse wheel scrolling, scrollbar dragging, text selection with copy, and hyperlink clicks are handled by pi-tui. On quit, the currently visible page is left printed in the terminal, like `less`.
