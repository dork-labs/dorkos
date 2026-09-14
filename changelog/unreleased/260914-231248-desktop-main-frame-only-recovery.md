---
covers:
  - "fix(desktop): a page still loading in an embedded frame no longer delays the desktop app's own recovery (DOR-2046)"
---

### Fixed

- The desktop app used to wait up to a minute before recovering a window that had failed, if a web page inside it was still loading. Now it only waits for the app's own page (DOR-2046)
