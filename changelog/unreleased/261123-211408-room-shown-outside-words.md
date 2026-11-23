---
covers:
  - 'fix(rooms): a room turn shown outside words is marked like one that answered them (DOR-4144)'
  - "fix(rooms): an agent's own posts no longer keep its room chat marked (DOR-4144)"
---

### Fixed

- When an agent in a room sees a message from someone outside your team, even one it isn't answering, it now asks you before it gets more access, spends money or edits its memory (DOR-4144).
- If you hand a draft to an agent in a room where it saw such a message, and it doesn't post it, the room now says it read words from outside your team rather than showing its reply (DOR-4144).
