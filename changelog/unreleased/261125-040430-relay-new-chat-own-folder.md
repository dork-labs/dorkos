---
covers:
  - 'fix(relay): a new chat an agent starts over relay opens in its own folder (DOR-5209)'
---

### Fixed

- A new chat an agent starts with a Relay message opens in that agent's own folder and runs as that agent, just like one it starts through the sessions API (DOR-5209).
- A program DorkOS can't name may now be refused when its Relay message would start a new chat in a default folder that holds private files, as the sessions API refuses it. Send to an agent's own address instead (DOR-5209).
