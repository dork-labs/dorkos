---
covers:
  - "fix(server): a server for every agent can't run from where agents write (DOR-3213)"
---

### Fixed

- An MCP server you add for every agent now only runs a program from a full path outside your agents' folders, and never with settings that load extra code into it. A saved server that breaks these rules isn't started.
- Choosing "Always allow" on one of these servers' tools now applies to that agent only, not every agent.
- A program on your computer that sends any kind of API key is never treated as you for owner-only changes, even before you've set up an account.
