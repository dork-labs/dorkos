---
covers:
  - 'fix(client,server,desktop): room notices link to the session they mention, and every session link is built one way (DOR-2077)'
---

### Fixed

- When an agent in a channel runs into a problem or is waiting for you to answer something, the note it leaves now has an "Open session" link that takes you straight to that agent's conversation. The note used to tell you to open the session without giving you a way to get there. (DOR-2077)
- The Session link button in Remote Access now copies the conversation's full address. It used to copy a shortened one that only reached the conversation by way of a redirect. (DOR-2077)
