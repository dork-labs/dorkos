---
covers:
  - 'fix(server): an agent offers the ways to connect an app DorkOS cannot reach yet (FB-57)'
---

### Fixed

- When you ask an agent to connect an app like Gmail and DorkOS can't reach it yet, the agent now tells you your choices right away: sign in to a DorkOS account (or create one), or use your own Composio key. It asks which you want and helps you do it. Before, it waited quietly while you were left to work it out alone
