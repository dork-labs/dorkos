---
covers:
  - 'feat(server,shared): a thread turn reads its thread plus a bounded channel tail (DOR-1207)'
---

### Changed

- An agent you call into a thread now reads that thread, not the whole channel. It arrives with the thread's messages and a short glance at the last few channel messages for background, so its answer is about what you asked in the thread instead of what the room was talking about an hour ago (DOR-1207)
