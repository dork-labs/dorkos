---
covers:
  - "fix(client): changing a scheduled task's agent asks before it stops the run asking (DOR-1637)"
  - 'fix(client): an agent pick waits for the runtime it cannot price yet, rather than guessing (DOR-1637)'
---

### Fixed

- Choosing a different agent for a scheduled task now asks first when that agent would stop the task pausing for permission. Agents can run on different tools, and the same permission setting can mean "ask me before you run a command" on one and "never ask" on another — so picking an agent could quietly leave a scheduled run free to do anything, with nobody there to notice. DorkOS now works out what the agent you picked would actually do before the change takes effect, and shows the same confirmation it already shows when you change the tool by hand: say yes and the change goes through, say no and the agent stays as it was (DOR-1637)
