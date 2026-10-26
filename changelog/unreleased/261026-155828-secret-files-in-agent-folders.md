---
covers:
  - "fix(server): DorkOS tells you when an agent's folder holds secret files it can read (DOR-3292)"
---

### Fixed

- DorkOS now tells you, in Needs you, when an agent's folder holds files that look like secrets, such as a dotenv file, a private key or a cloud credentials file. An agent can read any file in its own folder, whatever its rules say, so the only safe place for a secret is outside it. DorkOS checks file names only and never opens the files. The permission settings and docs now say this plainly, and the Never ask description no longer suggests it keeps the agent out of its own folder.
