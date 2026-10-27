---
covers:
  - 'fix(server): DorkOS reads git only through one runner that checks the repository first (DOR-3343)'
---

### Fixed

- When DorkOS reads a git repository for you, it now checks the repository's own settings first. If they ask git to run another program, DorkOS skips the read instead. These reads never use the network or your saved git logins, and they don't use your own git settings. (DOR-3343)
