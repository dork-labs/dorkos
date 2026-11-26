---
covers:
  - 'fix(api): the file browser is served by the capability mount (DOR-4978)'
---

### Changed

- Saving, making, deleting, moving and showing files in the app's file browser are now yours alone. An agent or a program with a key that asks for them through the API is turned away, before anything changes. Agents still change files with their own tools.
- Any program that calls with an API key or a sign-in token is now turned away from every one of those file changes. Before, a plain save did not check who was asking at all.
- On an agent computer, agents can no longer save, make, delete or move files through the file browser's API either. They use their own tools there too.
- Agents can now read a text file through `dorkos call`, as they already could through the API.
- From a device on your network that you haven't let run agents, running a document's unfinished work again is now refused. Clearing it, and reviewing or turning off a document's routes, still work there.
