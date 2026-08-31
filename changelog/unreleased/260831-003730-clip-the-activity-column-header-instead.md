---
covers:
  - 'fix(client): clip the Activity column header instead of letting it bleed (DOR-1287)'
  - 'fix(client): use truncate for the Activity header, matching the house pattern (DOR-1287 adversarial review)'
---

### Fixed

- The team table's column headers no longer overlap into garbled text (like
  "Manaigedy by") when the table is narrowed, such as by the Profile panel
  being open (DOR-1287)
