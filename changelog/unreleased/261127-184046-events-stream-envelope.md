---
covers:
  - 'feat(api): every GET /api/events frame carries the whole event, { seq, at, type, payload } (DOR-5474)'
---

### Changed

- Each event on `GET /api/events` now arrives whole. If you read this stream yourself, change your reader: the `data:` line is now `{ seq, at, type, payload }` instead of the bare payload. Read the event's data from `data.payload`, its type from `data.type`, and its place in the stream from `data.seq`. `at` is when it was sent. The `event:` and `id:` lines are unchanged, so listening by type and resuming with `Last-Event-ID` work as before. On the WebSocket at the same address, each message is the same `{ seq, at, type, payload }`, with the resume cursor beside it as `id`, and the keepalive is a `heartbeat` event.
