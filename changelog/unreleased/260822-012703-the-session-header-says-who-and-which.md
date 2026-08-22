---
covers:
  - 'feat(client): the session header shows who you are talking to and which conversation (DOR-1404)'
---

### Changed

- The bar above a session now shows who you're talking to and which conversation you're in: your
  agent's face and name, then the session's own title — the same title the sidebar list shows. It
  used to read "Team › DorkBot › Session", which was true of every session you've ever opened and
  never told you which one you were looking at. A brand-new session reads "New session" until your
  agent names it after the first reply, and then the header updates on its own. If the session
  isn't tied to an agent, the header shows the folder's name instead. Sessions started by something
  other than you — a scheduled task, a message from Telegram — still say so.
