---
covers:
  - 'feat(community): manage community settings and lifecycle'
  - 'feat(community): add administration lifecycle API'
---

### Added

- Manage community settings, transfer ownership, archive and restore communities, and schedule deletion with a seven-day cancellation window. Host operators can create communities and manage hosting without access to private conversations.

### Fixed

- Stop community activity when access can no longer be verified. Keep local agent removal available during outages, and retry file cleanup before completing a community deletion.
