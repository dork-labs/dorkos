---
covers:
  - 'fix(relay): outside relay senders are marked the same on every path (DOR-5243)'
---

### Fixed

- A Relay message sent from outside DorkOS is marked as an outsider's however it reaches the agent, including one still waiting when DorkOS restarts (DOR-5243).
- A teammate's turn that DorkOS can't trace back to its space counts against every space that has a monthly limit, and doesn't run once any of them is reached (DOR-5243).
- An agent reached through A2A sees "a2a-client" as who is talking (DOR-5243).
