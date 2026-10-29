---
covers:
  - 'fix(server): outside words no longer hold a whole room of agents to asking (DOR-3390)'
---

### Fixed

- Agents in a shared room stop asking you to approve their commands after one of them reads an outside message. Before, one message from outside your team could make every agent in the room ask before almost anything, and it never wore off. Now an agent that picked up outside words keeps working at its usual level. It still asks you before shell commands, permission changes, and actions that delete things or can't be undone. The agent that read the outside message directly is still held, as before.
