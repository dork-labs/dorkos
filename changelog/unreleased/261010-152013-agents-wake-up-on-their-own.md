---
covers:
  - 'fix(heartbeats): review round 1 — no wake loops, nothing gathered is lost, strangers per turn, manners hardened (DOR-2788)'
  - 'feat(heartbeats): agents wake on a beat or an event, look around for free, and tell people at a decent hour (DOR-2788)'
---

### Added

- Agents can now wake up on their own: on a regular beat or when something happens, they check what changed, do the work that is theirs, and tell you at a sensible hour. Every check leaves a line in the record. Each agent keeps a HEARTBEAT.md that says how it wakes and what it watches (DOR-2788)
