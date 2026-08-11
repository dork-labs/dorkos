---
covers:
  - 'fix(client): sidebar rows keep the right gutter they reserve, and gain a real slot for a control in it (DOR-1111, DOR-1115)'
---

### Fixed

- Long names in the sidebar now stop with a "…" instead of running under the row's menu
  button. Every row was supposed to keep a strip of space clear on the right, and that
  space had quietly gone missing, so a name past about 26 characters ran straight into the
  chrome beside it (DOR-1115)

### Changed

- A sidebar row can now carry a small control at its right edge, like a badge you can
  click. It travels with the row when you drag it, right-clicking it opens the row's own
  menu, and the keyboard reaches it with the arrow keys: from the row, press the right
  arrow to step onto it and again to reach the "⋮" (DOR-1111)
