---
covers:
  - 'feat(search): message search starts filling itself from your rooms'
---

### Added

- Your rooms now feed the message-search index, and it keeps itself current — anything said in a room lands there within five minutes. You still cannot search it: there is no search box yet, and nothing to ask a question of. That is the next piece (DOR-680)
- Nothing is kept in that index which does not already live in your rooms, so it can always be built again from nothing. If it ever falls out of step with what was really said, the next pass notices and repairs it without anyone having to intervene (DOR-680)
