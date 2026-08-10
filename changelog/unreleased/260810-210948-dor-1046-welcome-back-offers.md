---
covers:
  - 'feat(server,client): a welcome-back note can end in a next step, and only spends a turn when it does (DOR-1046)'
---

### Added

- Come back after a few hours and your agents already leave a short note about what moved. Now a
  note can also end with **one thing the agent wants you to decide** — "want me to open the PR?".
  There is no way to know an agent has a next step without asking it, and asking runs that agent
  for a turn, so this part is **off unless you turn it on**: Settings → Preferences →
  **Next-step offers**. When it is on, only the agents that already left you a note are asked, and
  each of them only once. An agent with nothing to offer says nothing; an agent that is busy or
  runs into trouble stays quiet too, and you still get the notes either way (DOR-1046)
