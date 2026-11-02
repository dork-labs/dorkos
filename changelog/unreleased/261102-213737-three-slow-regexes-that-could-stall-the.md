---
covers:
  - 'fix(security): three slow regexes that could stall the server are linear parses now (DOR-3661, DOR-3662, DOR-3663)'
---

### Fixed

- A specially made doc heading, note or web address can no longer freeze DorkOS for many seconds while it reads a title, a note or a site's address.
