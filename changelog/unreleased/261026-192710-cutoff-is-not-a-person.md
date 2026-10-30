---
covers:
  - 'fix(server): a turn DorkOS cuts off never reads as a person stopping it (DOR-3307)'
---

### Fixed

- When an agent goes quiet for 10 minutes, DorkOS stops its turn. That stop used to look like a person's: the chat showed "[Request interrupted by user]", and a tool that was running read as declined. Agents believed it and waited hours for a person who had done nothing. Now the chat says "DorkOS stopped this turn after 10 minutes with no activity," and the agent's next turn is told that no person stopped it.
