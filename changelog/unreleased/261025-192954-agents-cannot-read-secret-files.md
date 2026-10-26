---
covers:
  - "fix(server): an agent's Read tool can't open a secret file (DOR-3299)"
  - 'fix(server): cover the secrets the first pass missed, and every spelling (DOR-3299)'
  - 'fix(server): the read deny covers config backups, bot tokens and browser logins (DOR-3299)'
---

### Fixed

- An agent's file-reading tool can no longer open these files, at any permission level, Full included: DorkOS's own keys, settings and their backups, database, chat bot tokens, stored secrets and browser logins; the Claude Code, Codex and OpenCode sign-ins; and your SSH keys, cloud and GitHub tokens, and package-manager tokens. Before this, at Ask first and Act an agent could read them without asking. Tools like `git` and `gh` still read their own files as usual. Commands an agent runs in a shell are not covered yet.
