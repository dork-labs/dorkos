---
covers:
  - 'fix(rooms): address review — icon sizing, empty-DM copy, deterministic tests (DOR-525)'
---

### Fixed

- A channel's mark in the room header was stuck at the same small size as in the
  sidebar list, next to a direct message's larger letter disc. It now matches (DOR-525)
- "New direct message" told you every agent already had a conversation even when you had not
  added any agents at all. It now says so plainly, with a nudge to add one (DOR-525)
