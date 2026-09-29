---
covers:
  - 'fix(extensions): ask again after a reinstall, bind what the Settings card shows (DOR-2517)'
  - 'fix(extensions): approve only the copy a row showed, and keep the history honest (DOR-2517)'
  - 'fix(inbox): send the exact copy with every answer, and say who added an extension (DOR-2517)'
  - 'feat(server): list extensions waiting to be turned on and raise extension.approval (DOR-2517)'
  - 'feat(extensions): ask in the Activity inbox to turn on an installed extension (DOR-2517)'
---

### Added

- When you install a plugin that brings an extension, the Activity inbox now asks once whether to turn it on, and says what it adds. One click turns it on, and its tab appears right away. "Not now" removes nothing. (DOR-2517)
