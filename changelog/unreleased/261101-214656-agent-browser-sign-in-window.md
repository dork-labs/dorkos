---
covers:
  - 'feat(server): agents hand the Agent browser to you, and sign-ins happen in a window no agent can reach'
---

### Added

- When a page needs something only you can do, like a password, your agent now stops and hands the Agent browser to you. It can't see or use the browser until you give it back. Pressing Resume in the browser panel gives it back for now; the full controls come in a later update (DOR-3218).
