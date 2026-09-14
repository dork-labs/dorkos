---
covers:
  - 'fix(desktop): arm the reload watchdog only when a new page starts loading in the main frame (DOR-2041)'
---

### Fixed

- Desktop: the app no longer reloads its own window about ten seconds after you move to another page, or every ten seconds while a web page is open on a canvas. Each of those reloads threw away anything you had typed and not yet sent (#1860, DOR-2041)
