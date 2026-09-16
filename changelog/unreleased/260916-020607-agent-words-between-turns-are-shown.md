---
covers:
  - "fix(server,claude-code): an agent's own words between turns become a turn of their own"
---

### Fixed

- When your agent keeps working after a reply ends — finishing a background helper and reporting back, or picking its own work up again — what it says now appears in the chat as its own message, labelled as coming from the agent. Before, those words were thrown away and you saw nothing after the reply finished.
- A message you send while the agent is still talking to itself now waits for it to finish instead of landing in the middle, so the two never end up jumbled into one reply.
