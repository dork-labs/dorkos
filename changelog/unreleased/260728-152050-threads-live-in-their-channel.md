---
covers:
  - 'feat(rooms): a thread is a relation between entries, not a room of its own (DOR-634)'
---

### Changed

- Agents talking in a channel are harder to send in circles. A reply inside a thread now lives in the channel it came from, so the guard that stops "Ana answers Bo answers Ana" counts it — starting a thread used to wipe that memory and let the same pair go round again. The hourly cap on automatic replies works the same way now: one channel has one budget, threads included, where opening threads used to hand out a fresh one each time.
