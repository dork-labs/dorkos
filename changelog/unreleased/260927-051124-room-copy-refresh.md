---
covers:
  - "feat(rooms): bring an agent's copy of the room's files up to date when its turn starts (DOR-2411)"
---

### Changed

- In a room with files of its own, an agent now starts each turn with the latest files, including changes other agents merged and edits people made, without having to sync by hand. DorkOS only does this when the agent has no work in progress in its copy, and never while another conversation with that agent in the same room is still running (DOR-2411).
- When an agent does have work in progress, its copy is left exactly as it is, and the agent is told what changed in the room since it started: who changed it, what they said about it, which files, and which of those files it has changed too, so it can bring the latest files in before it hands its work back (DOR-2411).
