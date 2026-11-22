---
covers:
  - 'fix(rooms): a chat started with only its folder can hand a post to its room seat (DOR-5035)'
---

### Fixed

- An agent's chat that was started with only a folder, for example from the API or the command line, can now hand a post off to the agent's place in a room. Before, DorkOS refused it and said to start a new turn, which never helped. When a hand-off is refused now, the message says what is actually missing (DOR-5035).
