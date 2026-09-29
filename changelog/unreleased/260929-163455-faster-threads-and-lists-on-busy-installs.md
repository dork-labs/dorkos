---
covers:
  - 'perf(db): index the reads that scanned whole tables on a busy install'
  - 'perf(db): regenerate the query indexes as migration 0134 on current main'
---

### Changed

- Open the thread list, room members, an agent's sessions and mirrored Community rooms faster on a busy install. On a test install with 500,000 room messages, the thread list went from about ten seconds to under half a second.
