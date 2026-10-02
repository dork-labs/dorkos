---
covers:
  - 'fix(canvas): bind page reports and recording work to host frame lifetimes'
---

### Fixed

- Cancel pending browser work when its page changes, and keep delayed replies from changing the new page's reports or recording (DOR-2662).

### Changed

- Label browser reports and captures as page-reported, so agents know the page can alter what they see (DOR-2662).
