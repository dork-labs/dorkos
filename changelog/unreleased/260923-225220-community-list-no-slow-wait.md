---
covers:
  - 'fix(communities): stop one slow community from holding up the community list (DOR-2223)'
  - 'fix(communities): give each community a time limit to confirm your access, too (DOR-2223)'
  - 'fix(communities): never show counts from before a community refused them (DOR-2223)'
---

### Fixed

- The community list no longer waits for a slow community. Before, if one community took a long time to answer, the whole list waited for it, sometimes for ten seconds or more, every time it refreshed. Now each community gets under a second.
- A community that doesn't answer in time keeps the unread and mention counts it last reported, marked with when they were last checked. If it hasn't answered for a while, it shows as offline: you can still read what's saved, and it comes back on its own at the next refresh. A slow answer never makes DorkOS ask you to reconnect. (DOR-2223)
