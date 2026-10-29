---
covers:
  - 'fix(server): a turn that read outside words asks before it sends, installs or rewrites itself (DOR-3390)'
---

### Fixed

- On a turn that read words from outside your team, an agent asks before it sends email or changes your calendar through a connected account. It also asks before it edits its own instructions or git settings, installs a package or MCP server, links a chat to an agent, or changes a setting. An agent that sees a stranger's message in a bridged chat is held as before, even when another agent woke it.
