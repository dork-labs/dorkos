---
covers:
  - 'fix(rooms): follow-ups from the review of hand-off, read marker and report changes'
  - 'fix(rooms): a saved report reaches only the seat it was checked for, and a cut keeps part of an overlong character'
---

### Fixed

- When an agent's room chat had moved to a fresh chat, and you reopened the old one and set up a schedule from there, that schedule's updates went to the room. They now go to your direct messages with the agent. Schedules set up before the move still post in the room (DOR-3753).
- When a spin-off chat's report is cut short, the cut no longer breaks an emoji or an accented letter in half, and a code block it cuts into is closed, so the rest of the report doesn't show as code (DOR-3535).
