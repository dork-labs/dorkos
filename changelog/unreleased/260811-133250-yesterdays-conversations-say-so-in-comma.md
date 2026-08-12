---
covers:
  - 'feat(client): ⌘K says which conversations and channels are archived (P3.4, DOR-1076)'
---

### Added

- ⌘K now says when something it found is no longer current. A conversation where nothing has
  happened since early this morning, and a channel somebody has closed, both carry a small
  **Archived** label. You can still find them by name and still open them — the label is only
  there so a row cannot look like part of today's work when it is not (DOR-1076).

### Changed

- A quiet conversation now sits below a busy one when they match what you typed equally well. It
  is not pushed to the bottom of the list, though: something you go back to constantly still
  comes up first, whatever day it last moved. A closed channel is the one thing that always ranks
  below everything still going (DOR-1076).
