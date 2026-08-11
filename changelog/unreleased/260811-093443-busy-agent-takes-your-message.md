---
covers:
  - 'feat(server): a busy agent takes your message instead of refusing it (P2.4, DOR-1131)'
---

### Changed

- Sending a message to an agent that is already working no longer comes back as an error.
  The message is accepted right away and runs as soon as the current turn finishes, so
  nothing you typed bounces back at you. This works across windows too: a message you send
  from a second window waits in the same line, and either window can see it, reword it, or
  take it back before it runs (DOR-1131)
