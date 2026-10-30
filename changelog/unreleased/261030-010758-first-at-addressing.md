---
covers:
  - 'feat(rooms): only the leading @mentions wake an agent; later ones are cc (DOR-3401)'
---

### Changed

- In a channel, only the names at the start of a message ask anyone to answer. "@ana @bo: ship it" asks both. A name later in the message is a copy: that agent takes no turn, and it sees the message the next time it reads the room. Copied names show as grey chips, and the composer says "Asks @ana · cc @bo" as you type. Direct messages work as before.
