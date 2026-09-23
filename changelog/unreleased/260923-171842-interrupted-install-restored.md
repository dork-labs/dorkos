---
covers:
  - "refactor(marketplace): one shared predicate for the install engine's sibling directories (DOR-2273)"
  - 'fix(marketplace): restore an interrupted install instead of deleting its backup (DOR-2273)'
---

### Fixed

- If DorkOS stops in the middle of installing or updating a package, you get the package back the way it was. Before, a crash at the wrong moment could leave you with neither the old version nor the new one, because DorkOS later deleted the saved copy of the old version instead of putting it back.
- A package that was half-installed when DorkOS stopped is now cleaned up the next time DorkOS starts, instead of showing up broken.
- When two copies of DorkOS work on the same project, one no longer undoes an install the other is still in the middle of. If you try to install a package while the other copy is installing it, you are asked to try again in a few minutes.
- A plugin's leftover saved copy no longer shows up to your coding agents as a second copy of the same plugin's skills.
