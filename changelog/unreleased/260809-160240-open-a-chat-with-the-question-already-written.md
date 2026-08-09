---
covers:
  - 'feat(session): open a chat with the question already written (DOR-1054)'
---

### Added

- **A link can bring the question with it.** Add `?prompt=` to a session address
  and DorkOS opens a new chat with those words already in the box — yours to
  read, change, or send. Add `&send=1` and it sends them for you, so the agent is
  already working by the time you look at the screen.
- It sends once. Refreshing the page or pressing Back will not send it a second
  time, because the address drops both settings the moment they are used. And it
  only ever starts a conversation: pointed at a chat that already has messages,
  or at a box you have started typing in, the link does nothing at all.
