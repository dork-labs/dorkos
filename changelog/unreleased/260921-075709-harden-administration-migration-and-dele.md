---
covers:
  - 'fix(community): harden administration migration and deletion worker'
---

### Fixed

- Community deletion retries failed file cleanup without removing another community’s files or the server’s accounts.
