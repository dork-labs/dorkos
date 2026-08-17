---
covers:
  - 'fix(client,server): a question the agent asked is still there to answer after you refresh (DOR-1269)'
  - 'fix(client): one card, not two, for a prompt parked across a refresh (DOR-1269)'
  - 'fix(client): only dedup the parked duplicate, never a reused tool call id (DOR-1269)'
---

### Fixed

- A question or an approval the agent is waiting on now survives a page refresh. Reloading the tab
  used to hide the card behind a "Question answered" line, for a question nobody had answered. That
  left no way to answer it, and the agent sat stuck until it gave up. The card comes back now, ready
  to answer, and it is the only thing on screen for that question (DOR-1269)
