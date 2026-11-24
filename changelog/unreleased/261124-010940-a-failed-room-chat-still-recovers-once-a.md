---
covers:
  - 'fix(rooms): a failed room chat still recovers once after DorkOS restarts (DOR-4626)'
  - "fix(rooms): a restored recovery keeps the failed turn's limits and never outlives a crash loop (DOR-4626)"
---

### Fixed

- When another chat asked an agent to post in a room, and that agent's room chat had stopped on a server error, the post failed if DorkOS had restarted in between. The agent now gets one fresh chat in the room, as it would without the restart, with the same limits its old chat had (DOR-4626).
