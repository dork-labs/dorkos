---
covers:
  - "fix(server): an agent's tools can't open a secret-named file in its own folder (DOR-3292)"
---

### Fixed

- An agent can no longer open a file like `.env` or a private key in its own folder by name, with its Read tool or a shell command, at any permission level. A search of the whole folder can still find what's inside, so move secrets out of agent folders. (DOR-3292)
