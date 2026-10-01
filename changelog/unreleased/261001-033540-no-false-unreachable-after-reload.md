---
covers:
  - 'fix(client): ask the server once on every page load before calling it unreachable'
  - 'fix(client): keep the server hang deadline running through paused and cancelled reads'
---

### Fixed

- The app no longer swaps itself out for "DorkOS can't reach its server" about 15 seconds after a quick reload when the server is fine. That brief swap could clear what you had open, like a channel mid-conversation, before putting it back. If the server really is down or stuck, you still see the message. (DOR-2649)
