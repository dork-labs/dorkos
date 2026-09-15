---
covers:
  - "fix(client): the session header no longer doubles a room's `#` (DOR-2073)"
  - 'fix(client): clarify the `#` strip and the DM guard test (DOR-2073)'
---

### Fixed

- The bar above a session opened from one of your own rooms said "# #proj-trame" — the room's own name already starts with `#`, and the mark beside it drew a second one. The visible name now reads `#proj-trame` once, with the full form still available to screen readers (DOR-2073)
