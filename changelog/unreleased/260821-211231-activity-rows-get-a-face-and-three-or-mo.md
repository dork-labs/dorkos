---
covers:
  - 'feat(client): Activity rows get a face, and three or more of the same kind collapse into one (DOR-1396)'
---

### Added

- Activity rows now show who did it. When a notification is about one of your agents, its row shows that agent's own color and icon instead of a plain bell or checkmark, so you can tell at a glance who finished a run, sent a message, or hit an error (DOR-1396).
- When the same agent does the same thing three or more times in a row, like finishing four runs back to back, those rows now fold into one line ("Alpha Bot finished 4 runs") that you can open to see each one. A single event, or just a pair, still shows on its own (DOR-1396).

### Fixed

- A notification with nowhere to go, like a DorkOS update record, no longer draws as a button that looks clickable but does nothing. It now reads as plain text; the dot still clears when you use "Mark all read" (DOR-1396).
