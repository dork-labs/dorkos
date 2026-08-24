---
covers:
  - 'fix(client,server,shared): an Ask keeps its countdown, and Stop never drops your parked draft (DOR-1442)'
---

### Fixed

- A question or form an agent is waiting on now keeps one deadline wherever you look at it. The time limit rides along with the prompt, so the countdown keeps ticking down instead of starting over whenever the card is redrawn (DOR-1442)
- Pressing Stop while you were editing a queued message no longer loses the message you had parked in the box, even if the message you were editing had already been sent by then (DOR-1442)
