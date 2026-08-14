---
covers:
  - 'feat(server,shared): a room gathers a burst into one turn, and a mid-turn message steers it (DOR-1201)'
  - 'fix(server): judge a gathered batch one message at a time, and pin the halt ordering (DOR-1201)'
---

### Added

- Settings for how long a channel waits before an agent answers, and how many messages one answer covers (DOR-1201)

### Changed

- Several people talking at once now get one considered reply instead of several rushed ones. Messages sent within half a second of each other are read together and answered once (DOR-1201)
- A message you send while an agent is working is folded into its next answer, marked as having arrived while it was busy — instead of getting an "it didn't pick this up" note and waiting for someone else to speak (DOR-1201)
- Stopping a room now also drops the messages it was about to answer, so pressing Stop is the end of it (DOR-1201)
