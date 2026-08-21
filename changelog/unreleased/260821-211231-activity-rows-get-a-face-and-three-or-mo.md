---
covers:
  - 'feat(client): Activity rows get a face, and three or more of the same kind collapse into one (DOR-1396)'
  - 'fix(client): the glyph slot stops jittering, group expand state survives Load more, and burst phrases stop naming kinds that can never group (DOR-1396)'
---

### Added

- Activity rows now show who did it. When a notification is about one of your agents, its row shows that agent's own color and icon instead of a plain bell or checkmark, so you can tell at a glance who finished a run or sent a message. A row about something going wrong still shows its red icon instead, so a problem never gets lost behind a friendly face (DOR-1396).
- When the same agent does the same thing three or more times in a row, like finishing four runs back to back, those rows now fold into one line ("Alpha Bot finished 4 runs") that you can open to see each one. A single event, or just a pair, still shows on its own (DOR-1396).

### Fixed

- A notification with nowhere to go, like a DorkOS update record, no longer draws as a button that looks clickable but does nothing. It now reads as plain text; the dot still clears when you use "Mark all read" (DOR-1396).
