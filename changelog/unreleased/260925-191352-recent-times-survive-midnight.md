---
covers:
  - 'fix(client): show recent times as minutes ago just after midnight'
---

### Fixed

- Something that happened a few minutes ago now reads "5m ago" even when midnight has passed since. Before, for about an hour after every midnight, it read "Yesterday, 11 pm" instead, which made fresh things look old. Anything from the last six hours now counts in minutes or hours; older than that, a time from yesterday still shows as "Yesterday" with the hour.
