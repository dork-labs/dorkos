---
covers:
  - 'fix(browser): a site that keeps reloading hands the page to the person, and successful clicks stop showing as failed (DOR-4816, DOR-4817)'
---

### Fixed

- Offer a browser handoff when a page keeps reloading or stays empty after loading.
- Report successful browser navigation and link clicks as successful, even when the old page disappears.
- Distinguish an unreadable full-screen state from a page actually being in full screen.
