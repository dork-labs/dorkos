---
covers:
  - 'fix(cli): give a self-hosted community the keys to its file storage (DOR-2559)'
  - 'fix(cli): deploy staged Fly secrets without the flag flyctl rejects (DOR-2559)'
  - 'fix(cli): hand the storage keys to the app first and explain a keys-missing stop (DOR-2559 review)'
---

### Fixed

- Setting up your own community with `dorkos community deploy` no longer stops right after it creates the file storage for uploads. Setup now reads the storage's answer correctly, and it hands the storage keys to your community itself, since Fly leaves that step to whoever creates the storage. It hands the keys over the moment the storage exists, before anything else can go wrong. If they still go missing, setup stops and tells you how to add them by hand and carry on, and it never replaces keys your app already has. Setup also no longer fails at the last step, when it replaces your community's one-time setup key: it was passing Fly an option that step doesn't accept (DOR-2559)
