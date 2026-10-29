---
covers:
  - "fix(server): an agent's file tools can't change DorkOS's settings file or another agent's setup (DOR-3068)"
  - 'fix(server): on every launch deny only the four agent authority files (DOR-3068)'
  - "fix(server): an agent's file tools can't change another agent's skills, commands or subagents (DOR-3068)"
  - "fix(server): a changed or updated mini app's card says only what changed (DOR-3068)"
  - 'fix(client): the Inbox says what each waiting mini app is waiting for (DOR-3068)'
  - 'fix(client): the changed-mini-app line uses the warning tokens and a 44px Review on touch (DOR-3068)'
  - "fix(server): approve only what an agent's new mini app scaffolded, and show a changed app waiting (DOR-3068)"
  - 'fix(server): mark only approved dev-link sources as pre-existing (DOR-3068)'
  - 'fix(server): resolve extension links by real path, and bind only pre-existing approvals (DOR-3068)'
  - "fix(server): close the second review's gaps in the extension pin (DOR-3068)"
  - 'refactor(server): move the create_extension handler into its own module (DOR-3068)'
  - 'fix(server): an edited extension waits for a person before its new code runs (DOR-3068)'
---

### Fixed

- An agent's file tools can no longer change DorkOS's own settings file, where your approvals are kept. They also can't change the files that give an agent in DorkOS's data folder its powers: its settings, its MCP servers, its agent file, and its skills, commands and subagents. The settings file stays off-limits at every permission level. The other agents' files are off-limits below Full: a chat set to Full autonomy can change them, and the Activity page notes it. Agents can still edit their own instructions, and skills in a project's own folders.
