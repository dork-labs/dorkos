---
covers:
  - 'feat(client): the session header says who you are talking to and which conversation (DOR-1404)'
  - "fix(client): the session bar yields in order instead of painting over itself, and holds a deleted agent's name (DOR-1404)"
---

### Changed

- The bar above a session now shows who you're talking to and which conversation you're in: your
  agent's face and name, then the session's own title — the same title the sidebar list shows. It
  used to read "Team › DorkBot › Session", which was true of every session you've ever opened and
  never told you which one you were looking at. A brand-new session reads "New session" until your
  agent names it after the first reply, and then the header updates on its own. If the session
  isn't tied to an agent, the header shows the folder's name instead. Sessions started by something
  other than you — a scheduled task, a message from Telegram — still say so, and on a narrow window
  that note shrinks to its icon so the conversation's name keeps the room. If you delete an agent
  while you're reading one of its conversations, the header keeps its name rather than going blank —
  it's still the agent that wrote everything on screen.
