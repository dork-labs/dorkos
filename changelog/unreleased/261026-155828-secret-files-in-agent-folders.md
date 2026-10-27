---
covers:
  - "fix(server): DorkOS tells you when an agent's folder holds secret files it can read (DOR-3292)"
  - 'fix(server): say folder secrets honestly, in the inbox, on both permission pages (DOR-3292)'
  - 'fix(server): the folder-secrets notice gives no advice an agent can step around (DOR-3292)'
---

### Fixed

- DorkOS now tells you, in your inbox, when an agent's folder holds files that look like secrets, such as a dotenv file, a private key or a cloud credentials file. An agent can read any file in its own folder, whatever its rules say. Moving a secret out keeps it out of searches through the folder, though an agent can still read files outside it today. DorkOS checks file names only and never opens the files. The permission settings and docs now say this plainly, and the Never ask description no longer suggests it keeps the agent out of its own folder.
