---
covers:
  - 'fix(server): an update holds the package folder from start to finish (DOR-1722)'
---

### Fixed

- Updating a marketplace package no longer destroys another install of that same package that arrives while the update is running. An update takes the old copy away and puts the new one down, and for a moment in between the folder was unguarded: anything installed in that moment was deleted without a word, even though whoever installed it had already been told it worked. The update now holds the folder from start to finish (DOR-1722)
