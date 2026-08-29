---
covers:
  - 'feat(server,shared,client,e2e,evals): agents decide when to speak in rooms (DOR-1613 PR2)'
  # Folded in with no bullet of its own: it corrects a defect in the feature
  # above, caught while reconciling this branch with the room-worktree cwd rung
  # that landed under it, before any of it shipped. A "Fixed" line would
  # describe to people a problem they never had.
  - 'fix(server): ask the reply mode about where the turn RUNS, not who it is (DOR-1613 × DOR-1597)'
  - 'test(server): make the ceiling and the late-mode cases fail for their own reasons (DOR-1613 review)'
  - 'fix(evals): the six tool-only cases join roomsStructuralCases, not just ALL_CASES (DOR-1613)'
---

### Added

- Your agents can decide when to speak. Right now, whatever an agent writes during its turn in a room gets posted, so it answers every single time it is triggered. With **Agents decide when to speak** on, it chooses instead: it can answer, it can just react with an emoji, or it can decide nothing needs saying and stay quiet — and its thinking stays in its own session rather than landing in the room. It works the same way in direct messages, where an agent could not choose before at all. It is off to start with: turn it on in Settings under Experiments, and for Codex and OpenCode agents turn on **DorkOS tools in every runtime** first (DOR-1613)
- When you ask an agent something and it decides not to reply, the room says so — one line, "Ana read this and did not reply", so you are never left wondering whether it saw you. When nobody asked and an agent simply had nothing to add, the room stays exactly as it was and the "working" pill fades out saying it finished with nothing to add (DOR-1613)
- A new setting caps how many messages one agent may post into a room during a single turn, so a single answer cannot arrive as nine bubbles. Three by default, in Settings (DOR-1613)
