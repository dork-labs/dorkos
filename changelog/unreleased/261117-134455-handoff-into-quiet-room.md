---
covers:
  - 'fix(rooms): a post handed to an agent in a room nobody has posted in yet gets posted (DOR-4619)'
---

### Fixed

- When an agent posted into a channel nobody had written in yet, from its direct chat or a task, the post never showed up. Its chat in that channel said there was "nothing to answer". Now the post goes up, as it does in any other channel. The same fix lets a spin-off chat report back to an agent in an empty channel. (DOR-4619)
