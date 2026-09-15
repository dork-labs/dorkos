---
covers:
  - 'fix(sessions): one unreadable message no longer stops a whole session from loading (DOR-2078)'
  - 'fix(sessions): show an unreadable message as a quiet note, not a failure (DOR-2078)'
---

### Fixed

- A session with one damaged message in its history now opens. Before, a single message the app couldn't read made the whole session fail with "Session not found". Now the rest of the conversation loads, and a quiet note sits where the unreadable part was. The note is calm on purpose: an old damaged message is not your agent failing, so it no longer looks like it. If your agent asks you a question, or asks for your OK, and the app can't show it, you get a note saying so, instead of an agent that seems stuck for no reason. (DOR-2078)
