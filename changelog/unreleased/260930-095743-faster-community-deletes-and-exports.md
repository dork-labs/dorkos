---
covers:
  - 'perf(community): check each tenant reference once, and bound watermark and roster reads (DOR-2571, DOR-2572)'
  - "fix(community): cap 0027's lock waits and guard the bounded queries' call sites (DOR-2571, DOR-2572)"
---

### Changed

- Delete a large community faster, and post with less work: the server now checks each link between a community's records once instead of twice. On a test community of a million messages, deleting it went from about two minutes to under a minute and a half.
- Start an export or a member's erasure without first reading every message in the community. On the same test community, that step went from 107–157 milliseconds to under one. Posting and opening a channel's member list now look up that community's members instead of every membership on the server.
