---
covers:
  - 'refactor(relay,shared): one abort registry, one bounded interrupt (DOR-791)'
  - 'fix(relay): an agent turn can be stopped, and the stop reaches the model (DOR-791)'
  - 'fix(a2a-gateway): tasks/cancel stops the turn, or says it could not (DOR-791)'
  - 'fix(relay,a2a-gateway): a queued turn is cancelable, and never starts once stopped (DOR-791)'
---

### Fixed

- Canceling a task from another AI tool now actually stops the agent. Before, DorkOS
  replied "canceled" and the agent kept working — and kept costing you money — until it
  finished on its own. The cancel is now passed to whoever is running the turn, and you
  are only told it stopped when something confirms it did. If nothing can be stopped,
  you get an error saying so instead of a comfortable lie (DOR-791).
- When an outside tool waits two minutes for an answer and gives up, DorkOS now asks the
  agent to stop too, and writes to the server log whether that worked (DOR-791).
