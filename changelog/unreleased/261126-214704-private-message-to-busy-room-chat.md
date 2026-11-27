---
covers:
  - 'fix(rooms): a private message to a busy room chat ends in two minutes, not an hour (DOR-5301)'
---

### Fixed

- A private message to an agent's busy chat in a room no longer waits up to an hour. If the agent is still busy two minutes after the message was sent, the message stops waiting and the sending chat shows why: send it again later. An answer to a question the agent asked still waits for it, up to an hour. (DOR-5301)
