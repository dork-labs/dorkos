---
covers:
  - 'fix(operating-skills): bump the pack to 35 for the room copy refresh note (DOR-2411)'
  - "fix(rooms): never remove another process's git lock after a refresh fails (DOR-2411)"
  - "fix(rooms): leave a room copy alone when the room's git settings name a program (DOR-2411)"
  - 'fix(rooms): hold a room copy with hidden edits, and clean up after a stopped refresh (DOR-2411)'
  - 'docs(rooms): tell agents their room copy is brought up to date at turn start (DOR-2411)'
  - 'fix(rooms): keep a file name or commit subject on its own line in the what-moved heads-up (DOR-2411)'
  - "feat(rooms): bring an agent's copy of the room's files up to date when its turn starts (DOR-2411)"
---

### Changed

- In a room with files of its own, an agent now starts each turn with the latest files, including changes other agents merged and edits people made, without having to sync by hand. DorkOS only does this when the agent has no work in progress in its copy, and never while another conversation with that agent in the same room is still running (DOR-2411).
- When an agent does have work in progress, its copy is left exactly as it is, and the agent is told what changed in the room since it started: who changed it, what they said about it, which files, and which of those files it has changed too, so it can bring the latest files in before it hands its work back (DOR-2411).
