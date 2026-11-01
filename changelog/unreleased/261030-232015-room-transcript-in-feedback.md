---
covers:
  - "feat(feedback): attach a room's recent messages to a feedback report (DOR-2108)"
  - 'fix(feedback): room reports send only what the preview showed, and chips show a check (DOR-2108)'
  - 'chore(feedback): census the room preview route and give feedback its own transport slice (DOR-2108)'
  - "fix(feedback): shorten the room preview's scope line under the 16-word copy limit (DOR-2108)"
  - 'fix(feedback): the Also send chips use the focus-ring-inset recipe (DOR-2108)'
---

### Added

- Attach a room to a feedback report. In a channel, a direct message or Home, a "This room" chip sends that room's last 30 messages. It stays off until you turn it on, because a room holds other people's words. Preview shows exactly what goes, with home paths and secrets removed and file names left out. A message that arrives after you open the preview is not sent. (DOR-2108, FB-35, FB-62)

### Changed

- The "Also send" chips in the feedback form show a check when they are on, and their preview button is easier to tap on a phone.
