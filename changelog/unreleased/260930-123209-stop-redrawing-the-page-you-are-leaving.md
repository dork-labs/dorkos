---
covers:
  - 'fix(client): stop redrawing the page you are leaving when a navigation starts (DOR-2616)'
  - 'test(e2e): count the message boxes drawn on the way back to Home (DOR-2616)'
---

### Fixed

- Going to another page no longer draws the page you are leaving a second time first. For a split second the old page came back, and its message box could take your cursor on the way out. The short fade meant for the new page also played on the old one, so the new page just appeared (DOR-2616)
