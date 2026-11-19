---
covers:
  - "fix(turn-power): a chat that took in a stranger's words stays held until your own next message (DOR-4515)"
---

### Fixed

- A chat that took in words from someone outside your team now stays held until you send your own next message in it. Until then, a scheduled run, a heartbeat or another agent's message in that chat asks before it sends anything outside, raises its own power, reveals a secret or does something it can't undo. Waiting never clears the hold.
