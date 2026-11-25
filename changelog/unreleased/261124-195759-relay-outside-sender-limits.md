---
covers:
  - 'fix(relay): relay messages from outside senders carry their limits plainly (DOR-5201)'
---

### Changed

- A Relay message from anyone but you can no longer set the name or chat shown to the agent that reads it. Only Telegram, Slack and other chat connections name who is talking (DOR-5201).
- A Relay message sent from outside DorkOS is always marked as an outsider's, so every check that asks before risky actions sees it (DOR-5201).
