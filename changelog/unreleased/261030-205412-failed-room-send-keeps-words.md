---
covers:
  - 'fix(client): a failed room send keeps your words and offers Retry (DOR-3481)'
---

### Fixed

- When DorkOS isn't answering and a message to a room or thread can't go out, your words go back into the message box and the message says "Not sent." The error now has a Retry button, which works even if you've left the room.
