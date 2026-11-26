---
covers:
  - "fix(api): an agent's Heartbeat page, permissions and level, and moving an old persona, are served by the capability mount (DOR-4978)"
---

### Changed

- For scripts that use the DorkOS API: one agent's Heartbeat page, permissions and level have new operation names (`heartbeat.view_page`, `permissions.view_agent` and `permissions.view_agent_level`), with the same paths, and the same answers for whoever could read them before. Moving an old persona into SOUL.md is now in the API document too, as `agent.migrate_persona`.
- An agent's Heartbeat page and moving an old persona are now a person's. A call from an agent, or one that sends an API key or any `Authorization` header, is refused with `person_only`. Agents read a heartbeat with `heartbeat_status`.
- A Heartbeat page asked for a number of days it can't show, and a persona move sent with no folder, now answer with a validation problem that names the field and lists it under `issues`. While heartbeats aren't running, the page answers that they aren't running yet, not that the address doesn't exist.
