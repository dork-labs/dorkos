---
covers:
  - 'fix(rooms): a hand-off waiting in the queue still posts after a restart, from a chat its runtime no longer knows (DOR-5087)'
---

### Fixed

- A room hand-off that was waiting its turn when DorkOS restarted now posts once the agent is free, and the chat that asked hears back once. Before, it could be declined with "the chat stopped" when the chat had been started from the agent's folder alone (DOR-5087)
