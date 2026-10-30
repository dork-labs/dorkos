---
covers:
  - 'fix(feedback): reports fold repeated breadcrumbs, skip empty log lines, and name the app plainly (DOR-2234)'
---

### Fixed

- Bug reports you send from DorkOS are easier to read. The same event repeated back to back now shows once with a count, the server log excerpt no longer has empty lines, and the report names where it came from as "DorkOS app" instead of an old internal name. (FB-49)
