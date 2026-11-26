---
covers:
  - 'feat(api): one owner check for connection decisions, and three connection doors move onto the capability mount (DOR-4978)'
  - 'feat(api): one account-decision bar for hand routes and the capability mount; three connection doors move onto it (DOR-4978)'
  - 'fix(api): the server refuses to start when a capability behind the account-decision bar has no policy wired (DOR-4978)'
---

### Changed

- Seeing what disconnecting an app would touch, renaming a connected app and removing a disconnected one work as before, with the same answers and the same messages. They now run the same owner check every other connections action runs, from one place, so the check can't differ between them.
- These three can also be called by their action name through the API's general "run an action" address. Only you can use them there too; an agent or a program is still refused.
- Renaming or removing a connected app now adds a line to the activity log.
