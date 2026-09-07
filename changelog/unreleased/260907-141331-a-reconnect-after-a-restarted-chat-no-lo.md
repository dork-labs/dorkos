---
covers:
  - "fix(server): the SSE id frame carries a generation, so a stale cursor can't lie (DOR-1704)"
  - "fix(server): the seq-space generation follows the runtime's own session resolution (DOR-1704)"
---

### Fixed

- Reconnecting to a chat no longer skips replies. When two turns started on the same chat at once, the server could swap out the counter it uses to number that chat's events — and a window reconnecting afterwards asked to carry on from a position that no longer meant what it used to, so some replies simply never arrived and nothing looked wrong. Those windows now reload the conversation instead.
