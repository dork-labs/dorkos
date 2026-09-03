---
covers:
  - 'fix(client,e2e): a sidebar row is not a button inside a button (DOR-1418)'
---

### Fixed

- Sidebar rows, channels and sections read correctly to a screen reader again. Making them
  draggable had wrapped each one in a second, invisible button, and a button inside a button is
  something screen readers skip or garble. (DOR-1418)
