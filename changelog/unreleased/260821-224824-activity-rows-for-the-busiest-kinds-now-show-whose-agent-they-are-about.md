---
covers:
  - 'fix(server,relay): a finished turn, a stalled session, an unanswered question, and an undelivered message now name their agent (DOR-1408)'
---

### Fixed

- Activity rows for a finished turn, a session that stopped on an error, a question nobody answered, and a message that never arrived now show the agent's own picture instead of a plain icon, and several in a row from the same agent can collapse into one line. These were the four busiest kinds of activity, and until now they were the only ones that never said whose agent they were about (DOR-1408)
