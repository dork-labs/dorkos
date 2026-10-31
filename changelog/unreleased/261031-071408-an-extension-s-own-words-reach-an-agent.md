---
covers:
  - "fix(server): an extension's own words reach an agent defused and labelled (DOR-3514)"
---

### Fixed

- When an agent lists extensions or their errors, it's now told that each extension's name, description, errors and reasons were written by the extension's author, not by DorkOS. Text in those fields that's shaped like a DorkOS message boundary or system tag now reads as plain text, so an extension can't pass its own words off as instructions to a scheduled task (DOR-3514)
