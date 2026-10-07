---
covers:
  - 'feat(community): live updates wake on database notices instead of polling (DOR-2764)'
  - 'feat(community): readiness check, metrics, and limits on open live streams (DOR-2764)'
---

### Changed

- A Community server now sends new messages to open channels the moment they are posted, without asking the database four times a second for every open channel. One server can hold many more people at once, and someone who loses access, signs out or is removed is cut off within a moment (DOR-2764)

### Added

- Community hosts get a readiness check at `/health/ready` and monitoring numbers at `/metrics` (for a server key that can read spaces): open live streams, posts and joins per minute, database waits and how fast messages arrive (DOR-2764)
- Community hosts can cap how many live streams one server, and one space, may hold. Past either cap, a new stream is asked to try again shortly (DOR-2764)
