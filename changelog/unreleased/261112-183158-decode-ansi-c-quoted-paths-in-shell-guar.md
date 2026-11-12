---
covers:
  - 'fix: decode ANSI-C quoted paths in shell guard (DOR-4137)'
---

### Security

- Below Full, an agent's shell command now asks first when it names a private file with escape codes, like `$'\x2essh'` for `.ssh`.
