---
covers:
  - 'fix(mesh,server): a new agent keeps the namespace it was created in (DOR-1342, DOR-1343)'
---

### Fixed

- A new agent no longer changes namespace five minutes after you create it. The namespace is the group an agent's permissions hang off, shown in Team → Access. DorkOS put every agent it created into one shared namespace and then moved it into its own on the next background check, so two agents made in the app could talk for a few minutes and then quietly could not. They now land in the namespace they keep (DOR-1342)
- Permissions for a namespace nobody is in any more are cleared instead of lingering. Agents created by an older version still move once, on the first background check after you upgrade, and now that move takes the old namespace's access rules and mailbox with it (DOR-1342)

### Added

- The API reference now documents the two mesh topology endpoints — reading who can talk to whom, and changing it — including the "Let all my agents talk to each other" switch and what happens if you use `*` on only one side of a rule (DOR-1343)
