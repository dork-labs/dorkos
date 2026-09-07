---
covers:
  - "fix(server): the SSE id frame carries a generation, so a stale cursor can't lie (DOR-1704)"
---

### Fixed

- Reconnecting to a chat or a room no longer skips messages. If the server restarted the session's event stream while you were away, the app now reloads the conversation from scratch instead of picking up from a number that no longer means anything — which could quietly leave messages out with nothing to show anything had gone wrong.
