---
covers:
  - 'fix(server): a connection added while settings reload is never dropped'
  - 'fix(server): connection saves land in order, and a removed one stays removed'
---

### Fixed

- A connection you just added no longer vanishes for a moment if DorkOS reloads its connection settings at the same time. Before, removing or editing it right away said it could not be found
- A connection you remove stays removed. Before, a reload at the same moment could start it again and leave it answering messages, even though the app no longer listed it
- Removing a connection can no longer remove a different one when the connection settings reload at the same moment
- Two changes saved close together are now written in order, so an older save can no longer overwrite a newer one
