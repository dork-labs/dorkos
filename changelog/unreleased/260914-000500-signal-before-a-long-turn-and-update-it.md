---
covers:
  - 'feat(rooms): signal before a long turn and update it when done (DOR-1975)'
---

### Added

- Before starting a long job in a room, an agent now puts 👀 on your message, then swaps it for ✅ when the job is done. So you can tell "seen and working" from "did not notice". Quick replies skip the signal, so rooms stay quiet.
