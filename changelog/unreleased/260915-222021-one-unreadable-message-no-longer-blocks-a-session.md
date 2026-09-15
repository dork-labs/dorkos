---
covers:
  - 'fix(sessions): one unreadable message no longer stops a whole session from loading (DOR-2078)'
---

### Fixed

- A session with one damaged message in its history now opens. Before, a single message the app couldn't read made the whole session fail with "Session not found". Now the rest of the conversation loads, and a short note sits where the unreadable part was. If your agent asks you a question, or asks for your OK, and the app can't show it, you now see a note saying so, instead of an agent that seems stuck for no reason. (DOR-2078)
