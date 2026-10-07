---
covers:
  - 'feat(cloud-api): publish the remote enrolment request, edge proof and self-revoke (DOR-2763)'
  - 'fix(cloud-api): tighten the remote edge proof and enrolment rows after review (DOR-2763)'
---

### Added

- `@dork-labs/cloud-api` describes how a computer asks a person to approve DorkOS remote access: it shows a short code, the person approves it on a web page, and the computer checks back for the answer (DOR-2763)
- `@dork-labs/cloud-api` tells a computer how to check that a visit really came through DorkOS remote access, and refuse any that did not (DOR-2763)
- `@dork-labs/cloud-api` lets a computer cut off its own remote access, and explains how to recover when a new access key goes missing on the way (DOR-2763)

### Changed

- `@dork-labs/cloud-api` now says plainly that asking for a remote access key twice with the same request key is refused, instead of sending the key again. A computer that lost the answer asks again with a new request key (DOR-2763)
