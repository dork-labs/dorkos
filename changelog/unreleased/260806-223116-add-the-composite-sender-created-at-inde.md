---
covers:
  - 'perf(relay): add the composite (sender, created_at) index ADR-0014 committed to'
---

### Changed

- Sending messages between agents stays fast as message history grows — the rate limiter now looks up a sender's recent messages through an index instead of scanning the whole list every time.
