---
covers:
  - 'feat(rooms): line thread replies up with the message they answer, under a reply count (DOR-2110)'
  - 'refactor(rooms): count thread replies with one helper and pin the flush layout harder (DOR-2110)'
---

### Changed

- Replies in a thread now line up with the message they answer instead of being pushed in from the left, so they get the full width of the thread. A thin line that says how many replies there are separates the first message from the answers (DOR-2110).
