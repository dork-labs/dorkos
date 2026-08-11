---
covers:
  - 'fix(client): sidebar rows keep the right gutter they reserve, and gain a real slot for a control in it (DOR-1111, DOR-1115)'
  - 'fix(client): the trailing-action reservation refuses interactive content, loudly (DOR-1111)'
---

### Fixed

- Long names in the sidebar now stop with a "…" instead of running under the row's menu
  button. Every row was supposed to keep a strip of space clear on the right, and that
  space had quietly gone missing, so a name past about 26 characters ran straight into the
  chrome beside it (DOR-1115)
