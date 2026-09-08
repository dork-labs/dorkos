---
covers:
  - 'fix(harness): keep atomic sync writes reliable on Windows (DOR-1900)'
---

### Fixed

- On Windows, `dorkos harness sync` no longer stops if another process reads a generated file at the instant DorkOS replaces it. The sync waits briefly and tries that safe replacement again, while every reader still sees one complete version of the file (DOR-1900).
