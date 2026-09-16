---
covers:
  - "fix(server,claude-code): an agent's own words between turns become a turn of their own"
  - "fix(server,claude-code): a queued message waits for the agent's own turn, and Stop can reach it"
---

### Fixed

- When your agent keeps working after a reply ends — finishing a background helper and reporting back, or picking its own work up again — what it says now appears in the chat as its own message, labelled as coming from the agent. Before, those words were thrown away and you saw nothing after the reply finished.
- A message you send while the agent is still finishing its own work now waits its turn instead of landing in the middle, so your words and the agent's never end up jumbled into one reply. It waits at most half a minute, even if the agent never gets back to it.
- Pressing Stop while the agent is talking on its own now actually stops it. Before, you were told nothing was running.
