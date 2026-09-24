---
covers:
  - 'feat(marketplace): the Installed view says what is out of date and updates it (DOR-2196)'
---

### Changed

- The Marketplace's **Installed** tab now tells you which packages have a newer version before you click anything. Each package says "Update available: v1.2.0 → v1.3.0", "Up to date", or why it couldn't be checked, for example when a package is linked to a folder on your computer. The tab shows how many updates are waiting, even from Browse. **Update all** lists every package it will update, where it is installed and which version it moves to, and only updates those after you confirm. A package that is already up to date no longer has an Update button (DOR-2196).
