---
covers:
  - 'fix(client): one settings panel at a time, for screen readers too (DOR-693)'
---

### Fixed

- Screen readers now get exactly one panel per Settings tab: switching tabs briefly created a hidden second copy of the panel with the same id, which could confuse assistive tech (DOR-693)
