---
covers:
  - 'perf(community): index foreign keys and lookups by member, agent and account'

---

### Changed

- Delete a large community in minutes instead of more than an hour, and post, check unread mentions and erase a member faster in big communities. On a test community of a million messages, deleting it went from an hour and a half to under two minutes, and each post stopped reading every message on the server.
