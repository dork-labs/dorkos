---
covers:
  - 'fix(relay,shared,marketplace,server): keep relay and extension file lookups inside their own folders'
---

### Fixed

- Fixed a bug where the dead-letter list could be asked for an endpoint name that pointed outside the relay's own mailbox folder, and would read and return files from elsewhere on your machine. Endpoint names are now checked, and a name that could not belong to a mailbox comes back as a plain error instead

### Changed

- Asking the dead-letter list for an empty endpoint name is now an error rather than a way to get the whole list. Leave the filter off entirely to see everything
- Fixed a bug where a Shape from the marketplace could name an extension in a way that reached outside your DorkOS data folder when it checked whether a connection was set up. Extension names now have to look like extension names, everywhere DorkOS turns one into a file
