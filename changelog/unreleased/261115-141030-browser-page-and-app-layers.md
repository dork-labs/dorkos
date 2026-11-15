---
covers:
  - 'fix(client): the browser page stays put for tooltips elsewhere and hides behind dialogs (DOR-4417, DOR-4418)'
---

### Fixed

- In the desktop app, a web page open in the browser panel no longer vanishes when a tooltip or menu opens somewhere else in the window. It steps aside only while something is drawn over it.
- Settings and other dialogs now show above a web page open in the browser panel, instead of the page drawing on top of them.
