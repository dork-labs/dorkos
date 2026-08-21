---
covers:
  - "refactor(client): the Inbox popover and the knock/banner watch draw from one shared derivation of what's waiting (DOR-1397)"
---

### Changed

- The Inbox bell and the knock sound and desktop banners that alert you now always agree about what's waiting on you. They read from the same list, so one can no longer say something needs you while the other stays quiet (DOR-1397)
