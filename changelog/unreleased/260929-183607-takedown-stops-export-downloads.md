---
covers:
  - 'fix(community): stop export and icon downloads a takedown deletes, and keep files an author took out (DOR-2331, DOR-2332)'
---

### Fixed

- When a Community host takes something down, an export download that is already under way now stops right away instead of running on for up to 16 MB, and so does a download of a community icon that was taken down.
- A host's takedown of a message now also keeps, for the evidence copy, a file the author took out of that message shortly before, as long as the file is not yet deleted from storage. Before, only files from a message that was removed as a whole were kept.
