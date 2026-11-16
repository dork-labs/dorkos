---
covers:
  - 'fix(chat): explain queued messages held by pause (DOR-4348)'
  - 'fix(chat): keep paused drafts waiting for Send (DOR-4348)'
  - 'fix(chat): guard resumed drafts across delivery modes (DOR-4348)'
---

### Fixed

- Keep your paused message in the box until you resume the agent and press Send. New messages from other chats leave it there. Held messages name the pause in the queue, Activity and the sender’s receipt. (DOR-4348)
