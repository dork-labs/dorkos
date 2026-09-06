---
covers:
  - 'fix(server): errors folded into log context stop flooding either destination (DOR-1827)'
---

### Fixed

- Huge errors are now shortened everywhere, not just when DorkOS reports them on their own. Some places tuck the failure into a wider line of detail, and those lines used to carry the whole thing — one of them filled a log file with a single 1.2 MB line. They now get the same short version, with the same note saying how big the original was (DOR-1827)
