---
covers:
  - 'fix(communities): stop one slow community from holding up the community list (DOR-2223)'
---

### Fixed

- The community list no longer waits for a slow community. Before, if one community took a long time to answer, the whole list waited for it, sometimes for ten seconds, every time it refreshed. Now each community gets under a second. One that doesn't answer in time keeps the unread and mention counts it last reported, marked with when they were last checked, and the next refresh brings in the new counts. (DOR-2223)
