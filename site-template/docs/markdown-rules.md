# Markdown rules (CommonMark / markdown-it)

The prose island (`<script type="text/markdown" data-md>`) is rendered by **markdown-it**
(CommonMark). Follow these rules exactly — they are what keep the hierarchy from breaking:

- **Headings start at `###`** (the page title is the `<h1>`). `###` → section,
  `####` → sub-section.
- **Nest list items with 4 spaces per level.** The parser is real CommonMark; tabs or
  2/3-space indents are fragile — always use 4.
- **Attach an image (or sub-list) to a bullet** by leaving a blank line, then indenting it
  to the bullet's content column (4 spaces under the bullet). Blank lines inside a list do
  *not* end the list.
- **Images:** `![alt](assets/name.png)`. **Percent-encode spaces** in filenames as `%20`
  (a raw space ends the link in CommonMark and breaks the image). Prefer ASCII names with
  no spaces. Files must be **real PNG/JPG** — a TIFF renamed `.png` will not render
  (`file <img>` to check; convert if needed).
- Inline: `**bold**`, `` `code` ``, `[text](url)`. Korean text is fine.
- Don't hand-write `<ul>`/`<table>` HTML in the island — author markdown and let the
  renderer produce it.

Figures get a hover-zoom (scale-to-viewport-width) via the snippet in
[create-experiment.md](create-experiment.md).
