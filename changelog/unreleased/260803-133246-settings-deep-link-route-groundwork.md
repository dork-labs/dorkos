---
covers:
  - 'feat(client): let settings deep links resolve to a route (DOR-854)'
  - 'fix(client): warn in dev on an unknown settings deep-link tab (DOR-854)'
  - 'feat(client): let command-palette entries declare search aliases (DOR-854)'
---

### Changed

- Laid the groundwork so old `?settings=` links keep working the next time Settings gets
  reorganized — a link can now point at a page instead of only a settings tab. Nothing
  changes yet: this just makes future moves safe (DOR-854)
