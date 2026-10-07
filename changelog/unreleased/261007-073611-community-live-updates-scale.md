---
covers:
  - 'feat(community): live-notice listener, in-process hub and metrics text (DOR-2764)'
  - 'feat(community): notify live streams from every entry and access write (DOR-2764)'
  - 'feat(community): live streams wake on notices, with caps, readiness and metrics (DOR-2764)'
  - 'docs(community): document live-stream settings, readiness and metrics (DOR-2764)'
  - 'fix(community): a stream gives back its place, checks access at once, keeps its closed frame (DOR-2764)'
  - 'feat(community): per-member stream cap, a self-checking listener, readiness off the pool (DOR-2764)'
---

### Changed

- A Community server now sends a new message to open channels as soon as it is posted, instead of asking the database four times a second for every open channel. One server can hold many more people at once. When someone is removed, signs out, or loses access in any other way, their open channels close within a moment. A sign-in that simply runs out is noticed within about 15 seconds (DOR-2764)

### Added

- Community hosts get a readiness check at `/health/ready` and monitoring numbers at `/metrics`, for a server key that can read spaces. The numbers cover open live streams, posts and joins per minute, waits for the database, and how fast messages arrive (DOR-2764)
- Community hosts can cap how many live streams one server, one space, and one person or agent may hold. Past a cap, a new stream is asked to try again shortly (DOR-2764)
