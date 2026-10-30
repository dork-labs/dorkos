---
covers:
  - 'feat(server): an agent set to Full edits its own folder setup, and each change shows in Activity (DOR-3483)'
---

### Changed

- An agent you set to Full autonomy can now change its own setup: its hooks, skills, rules and settings, and its list of MCP servers. Before, it was blocked and had to ask you to copy the files in by hand. Each change it makes there shows in Activity, however it made it. It still can't change its own agent file, another agent's folder or DorkOS's settings, and a turn that read a message from outside your team can't change its setup either. If you move the agent below Full, what it changed waits for your OK once before it runs. Other agents' setup files are now off limits at Full too: before, a Full agent could change them.
