---
covers:
  - "fix(server): a copied data folder wakes none of the original's chats (DOR-3071)"
---

### Fixed

- Starting DorkOS from a copy of your data folder no longer wakes the chats of the install you copied it from. Before, a copy could restart those chats and run their tools a second time. A normal restart or upgrade still picks up the background work a restart cut short.
