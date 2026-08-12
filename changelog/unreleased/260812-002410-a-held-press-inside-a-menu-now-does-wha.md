---
covers:
  - 'fix(client,e2e): a held press inside an open menu does what it says (P4.2 review, DOR-1078)'
---

### Fixed

- On a phone, holding your finger on a row **inside** an open menu — rather than
  tapping it — did nothing at all. The menu stayed open and the thing you picked
  never happened. Holding now works the same as tapping, everywhere.
- Holding a row in the "⋮" menu opened a second menu on top of the first.
- The small number beside "Catch up" was too faint to read. It is darker now.
