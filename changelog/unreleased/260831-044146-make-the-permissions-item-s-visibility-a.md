---
covers:
  - "fix(client): make the Permissions item's VISIBILITY agree with its severity (DOR-820 review)"
---

### Fixed

- The Permissions status item no longer appears just because a mode's technical name isn't "default." It shows up only when the agent is actually acting with less oversight — the same fix DOR-820 shipped, now covering when the item appears, not just how urgent it looks
