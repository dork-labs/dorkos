---
covers:
  - 'feat(api): six more connection doors move onto the account-decision bar on the capability mount (DOR-4978)'
---

### Changed

- Checking a sign-in to an app, reading a change a program asked for, checking the sign-in for an agent's request, stopping sharing an app with every agent, leaving one agent out of a shared app, and reading how your connected apps were used all work as before, with the same answers and messages. They now run the one owner check every other connections action runs.
- These six can also be called by their action name through the API's general "run an action" address. Only you can use them there too; an agent or a program is still refused.
- Stopping sharing an app with every agent, and leaving one agent out of a shared app, now add a line to the activity log.
