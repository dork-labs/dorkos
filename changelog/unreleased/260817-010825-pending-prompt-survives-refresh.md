---
covers:
  - 'fix(client,server): a question the agent asked is still there to answer after you refresh (DOR-1269)'
---

### Fixed

- A question or an approval the agent is waiting on now survives a page refresh. Before, reloading
  the tab turned the card into a "Question answered" line for a question nobody had answered — and
  took away the only way to answer it, leaving the agent stuck until it timed out (DOR-1269)
