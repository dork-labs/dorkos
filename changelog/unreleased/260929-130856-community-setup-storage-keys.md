---
covers:
  - 'fix(cli): give a self-hosted community the keys to its file storage (DOR-2559)'
---

### Fixed

- Setting up your own community with `dorkos community deploy` no longer stops right after it creates the file storage for uploads. Setup now reads the storage's answer correctly, and it hands the storage keys to your community itself, since Fly leaves that step to whoever creates the storage. If setup is interrupted before the keys are handed over, running it again asks Fly for them once more, and stops rather than guess if they can't be found. It never replaces keys your app already has (DOR-2559)
