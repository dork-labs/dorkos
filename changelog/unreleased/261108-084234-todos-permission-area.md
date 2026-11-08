---
covers:
  - "fix(permissions): Blocked and Ask on agents' to-do tools now apply, in a new To-dos area (DOR-3936)"
  - "fix(permissions): a read says Ask lets it through, and to-do actions use the app's words (DOR-3936)"
---

### Fixed

- Blocking an agent's to-dos now stops it. Before, a Blocked saved for the to-do tools did nothing, and the agent could still add, change and read to-dos. They now have their own **To-dos** area in Permissions, Allowed by default, where you can set Blocked or Ask. A Blocked saved before this update now applies too. (DOR-3936)
- In Permissions, every action that only reads now says Ask lets it through, so you know only Blocked stops it. (DOR-3936)
