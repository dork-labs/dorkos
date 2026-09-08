---
covers:
  - 'fix(chat): preserve task order across history responses'
---

### Fixed

- Keep newly received chat tasks visible when an older history request finishes. Clear the list when a newer history response confirms it is empty.
