---
covers:
  - "fix(server,shared): GET /messages resolves a known session's cwd instead of a silent empty 200 (DOR-1322)"
---

### Fixed

- Asking DorkOS for a chat's messages now works without knowing the chat's folder — and when a chat truly can't be found, it says so instead of answering with an empty list.
