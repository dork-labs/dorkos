---
covers:
  - "fix(extensions): isolated extensions can't load node:sqlite, so they can't open DorkOS's database (DOR-3547)"
---

### Security

- Stop isolated extensions from opening DorkOS's own database: they can no longer load Node's built-in SQLite, which skipped their file limits (DOR-3547)
