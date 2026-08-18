---
covers:
  - 'feat(mesh,server,client): one switch lets every agent on this machine talk to every other (DOR-1338)'
  - 'fix(mesh,client): the switch survives losing dork.db, and its inert form stays readable (DOR-1338 review)'
---

### Added

- **Let all my agents talk to each other** — a single switch in Team → Access. Until now, two agents you made a minute apart could not message each other: each one lands in its own project, and agents only talk inside a project unless you add a rule for the pair, one dropdown pair at a time. Five agents meant twenty rules, and nothing told you until an agent hit the wall in the middle of a job. Flip the switch and every agent on this machine can reach every other one. Flip it back and you're where you were, with any pairs you'd already allowed still there. It's off when you install DorkOS — your agents stay in their own project until you say otherwise. (DOR-1338)
- The switch also shows up while you're making an agent, once you have another one it wouldn't be able to reach — so you find out before the agent does, not after. (DOR-1338)

### Changed

- When an agent is blocked from messaging another agent, it now names the switch and where to find it, so it can tell you exactly what to turn on. (DOR-1338)
