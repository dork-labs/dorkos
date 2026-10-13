---
covers:
  - 'fix(client): a held space post sends its files once, not twice (DOR-2835)'
  - 'fix: never post a stale upload, and reuse uploads on the space web page too (DOR-2835)'
  - 'fix: a lost-answer retry keeps its files, and uploads are dated from their first try (DOR-2835)'
---

### Fixed

- When a space holds your message (you're muted, slow mode is on, or you haven't accepted the rules yet) and you send it again, its files are no longer uploaded a second time. The files you already uploaded go with it. This works in the DorkOS app and on the space's web page, even if you edit the message first.
