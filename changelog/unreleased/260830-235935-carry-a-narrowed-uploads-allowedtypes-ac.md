---
covers:
  - 'fix(server): carry a narrowed uploads.allowedTypes across a config wipe (DOR-1505)'
---

### Fixed

- If you'd limited which kinds of files can be uploaded, resetting your settings no longer quietly allows every kind again ([DOR-1505](https://linear.app/dorkspace/issue/DOR-1505))
