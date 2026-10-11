---
covers:
  - "feat(heartbeats): agents report up once a day, wait for a manager who is away, and don't raise the same thing twice (DOR-2788)"
  - 'feat(heartbeats): agents report up once a day, skip a manager who is away, and never raise the same thing twice (DOR-2788)'
  - 'feat(profile): the Heartbeat page says who gets the next report and how much is in it (DOR-2788)'
  - 'fix(heartbeats): review round 1 — report lines clear only when the report arrives, honest de-duplication and away (DOR-2788)'
  - 'fix(heartbeats): review round 2 — an owed report runs when its reader is back, and hours changes move only report timers (DOR-2788)'
---

### Added

- Agents now send their manager one short report at the start of the workday instead of many small messages. While you're away, routine news waits for your return and only urgent messages reach you. An agent won't send you the same thing again while it's still open, and when two agents notice the same problem, you hear about it once. Each agent's Heartbeat page says who gets its next report and how much is in it so far (DOR-2788)
