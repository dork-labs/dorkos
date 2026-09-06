---
covers:
  - 'fix(client,e2e): keyboard focus follows a row you move between sections (DOR-1790)'
---

### Fixed

- Moving a sidebar row from one section into another with the keyboard now leaves you on that row in its new place. Before, the keyboard was left on nothing at all, so there was no highlight anywhere and the next Tab started again from the top of the page (DOR-1790)
