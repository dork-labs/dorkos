---
covers:
  - 'feat(server,shared): a thread turn reads its thread plus a bounded channel tail (DOR-1207)'
  - 'fix(server,shared): bound and disclose the channel unread a thread turn consumes (DOR-1207)'
---

### Changed

- An agent you call into a thread now reads that thread, not the whole channel. It arrives with the thread's messages and a short glance at the last few channel messages for background, so its answer is about what you asked in the thread instead of what the room was talking about an hour ago. The glance shows channel messages the agent has not read yet, and tells it how many more it did not get to see (DOR-1207)
