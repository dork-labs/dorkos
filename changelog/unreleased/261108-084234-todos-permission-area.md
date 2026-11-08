---
covers:
  - "fix(permissions): Blocked and Ask on agents' to-do tools now apply, in a new To-dos area (DOR-3936)"
  - "fix(permissions): a read says Ask lets it through, and to-do actions use the app's words (DOR-3936)"
  - 'fix(todos): agents can no longer change a to-do over HTTP, where no permission was checked (DOR-3936)'
  - "docs(permissions): Blocked on To-dos says what it stops, and the row covers the agent's own to-dos (DOR-3936)"
---

### Fixed

- Blocking an agent's to-dos now works. Before, a Blocked saved for the to-do tools did nothing. They now have their own **To-dos** area in Permissions, Allowed by default, where you can set Blocked or Ask. Set it to Blocked and the agent's to-do tools refuse. It still sees its own open promises on its heartbeat, and the team's list stays readable to everyone in the space. A Blocked saved before this update now applies too. (DOR-3936)
- An agent can no longer change a to-do through the app's web API, where no permission was checked. It uses its to-do tools, which follow your setting. (DOR-3936)
- In Permissions, every action that only reads now says Ask lets it through, so you know only Blocked stops it. (DOR-3936)
