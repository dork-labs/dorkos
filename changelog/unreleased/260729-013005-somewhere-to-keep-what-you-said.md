---
covers:
  - 'feat(db): give message search somewhere to keep what you said'
---

### Added

- DorkOS now ships the storage that message search will read: a table of what was said, and a full-text index over it that finds "dogs" when you typed "dog". There is nothing to search yet. The search box, and the part that fills this in from your rooms and your sessions, come next (DOR-679)
