---
covers:
  - 'fix(client): reading inside a space thread leaves the channel's saved row alone (DOR-2676)'
---

### Fixed

- Reading a thread in a space channel no longer loses your place in the channel. When you go back and reopen the channel, it opens where you were reading instead of at the newest message (DOR-2676)
