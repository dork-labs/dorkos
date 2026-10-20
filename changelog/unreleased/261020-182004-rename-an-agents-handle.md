---
covers:
  - "feat(rooms): a person can change an agent's @handle (DOR-3156)"
---

### Added

- You can now change an agent's @handle from its profile, the same way you change your own. Each room the agent is in gets one quiet line saying who renamed it, and messages you already sent still reach it.

### Changed

- DorkOS now turns down a handle that looks like someone else's, like `@d0rian` next to `@dorian`, and `@room` joins the reserved words.
