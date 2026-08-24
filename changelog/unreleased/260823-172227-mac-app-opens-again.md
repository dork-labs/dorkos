---
covers:
  - "fix(client,desktop): the desktop renderer builds with the client's defines — v0.63.0 black-window hotfix"
---

### Fixed

- The Mac app opens again. Version 0.63.0 could start to a black window that never loaded anything — the app was packaged with one piece of missing information, and it stopped before it could draw its first screen. Updating gets you a working app, and the build now refuses to package one with that fault in it (DOR-1448).
- If DorkOS can't save the panel it remembers between visits — some browsers block that, and so does the app in a few situations — it now starts fresh with a loading screen instead of showing you nothing at all.
- When DorkOS can't start its background server, the message it shows now points at the folder your logs are actually in.
