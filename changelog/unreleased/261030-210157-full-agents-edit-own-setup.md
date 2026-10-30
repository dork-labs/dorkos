---
covers:
  - 'fix(server): an open own folder keeps linked-in files, the account folder and host.key denied, and opens only for an agent-level Full (DOR-3483)'
  - 'test(server): directory-grants lists agents/ to deny writes, so the sibling-readers guard allow-lists it (DOR-3483)'
  - 'feat(server): an agent set to Full edits its own folder setup, and each change shows in Activity (DOR-3483)'
---

### Changed

- An agent you set to Full autonomy on its own Files & commands row can now change its own setup: its hooks, skills, rules and settings, and its list of MCP servers. Before, it was blocked and had to ask you to copy the files in by hand. Each change it makes there shows in Activity, however it made it. It still can't change its own agent file, another agent's folder, DorkOS's settings, your Claude account files, or a file its folder links to from somewhere else, and a turn that read a message from outside your team can't change its setup either. If you move the agent below Full, what it changed waits for your OK once before it runs. Other agents' setup files are now off limits at Full too: before, a Full agent could change them.
