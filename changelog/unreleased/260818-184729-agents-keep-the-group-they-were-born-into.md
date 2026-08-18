---
covers:
  - 'fix(mesh,server): a new agent keeps the namespace it was created in (DOR-1342, DOR-1343)'
  - 'fix(mesh): never sweep access rules on registry evidence alone (review fixes, DOR-1342)'
  - 'fix(mesh): a different manifest in a directory is not the same agent moving (review fix, DOR-1342)'
---

### Fixed

- A new agent no longer changes namespace five minutes after you create it. The namespace is the group an agent's permissions hang off, shown in Team → Access. DorkOS put every agent it created into one shared namespace and then moved it into its own on the next background check, so two agents made in the app could talk for a few minutes and then quietly could not. They now land in the namespace they keep (DOR-1342)
- When an agent does change namespace, it no longer leaves its old one behind it. An agent created by an older version still moves once, on the first background check after you upgrade, and that move now clears the permissions of the namespace it left, instead of leaving them there for good (DOR-1342)

### Added

- The API reference now documents the two mesh topology endpoints — reading who can talk to whom, and changing it — including the "Let all my agents talk to each other" switch and what happens if you use `*` on only one side of a rule (DOR-1343)
