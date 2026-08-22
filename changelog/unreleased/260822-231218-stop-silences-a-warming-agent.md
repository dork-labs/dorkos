---
covers:
  - 'fix(server): a stopped room turn can no longer post for itself (DOR-1313)'
---

### Fixed

- Stopping a channel now also stops an agent that was still warming up. Before, an agent
  that had just started could keep going and write its whole answer into the room long
  after you pressed Stop — once, a 7,000-character reply landed 23 seconds after the room
  said everything had been stopped. Nothing from a stopped turn reaches the room now, and
  the next message you send is answered normally (DOR-1313).
