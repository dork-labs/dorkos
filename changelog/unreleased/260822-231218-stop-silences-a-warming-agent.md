---
covers:
  - 'fix(server): a stopped room turn can no longer post for itself (DOR-1313)'
  - "fix(server): forget a room's Stop mark when the agent leaves the roster (DOR-1313)"
---

### Fixed

- An agent that was still starting up when you pressed Stop can no longer talk over it. Its
  answer used to arrive anyway — once, a 7,000-character reply landed 23 seconds after the
  room said everything had been stopped. That message is now turned away instead of posted,
  and the next thing you say is answered normally (DOR-1313).
