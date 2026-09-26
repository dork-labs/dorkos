---
covers:
  - 'fix(client,server,desktop): room notices link to their session; one session-link helper (DOR-2077)'
  - 'fix(client): link the words of a room notice, and never open a session the room let go (DOR-2077)'
  - 'fix(client): find a notice's session words by the agent's name (DOR-2077)'
---

### Fixed

- When an agent in a channel runs into a problem or is waiting for you to answer something, the words in its note that tell you to open that agent's session are now a link that takes you straight there. The note used to tell you to open the session without giving you a way to get there. (DOR-2077)
- The Session link button in Remote Access now copies the conversation's full address. It used to copy a shortened one that only reached the conversation by way of a redirect. (DOR-2077)
