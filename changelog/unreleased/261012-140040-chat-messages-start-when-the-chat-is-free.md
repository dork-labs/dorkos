---
covers:
  - 'fix(server): a message waiting on a chat starts the moment that chat is free'
---

### Fixed

- A message one chat sends another now starts as soon as that chat is free. Before, if the chat had finished its turn but was still wrapping up background work, the message could sit in its queue for up to five minutes after the work ended, even after an interrupt
- A chat sending a second message to a busy chat now hears "queued" at once. Before, after a long wait, it could be held for up to five minutes before it heard back
- A chat started from a room conversation is now told to report in the room. Before, it was told to message a chat that cannot take messages, and every try was refused
