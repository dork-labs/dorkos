---
covers:
  - "feat(rooms): a person can change an agent's @handle (DOR-3156)"
  - 'fix(rooms): handle look-alike folds, a history row, and clearer refusals (DOR-3156)'
---

### Added

- You can now change an agent's @handle from its profile, the same way you change your own. Each room the agent is in gets one quiet line saying who renamed it, and messages you already sent still reach it. Renaming an agent needs a secure connection, so a phone on plain Wi-Fi can't do it yet.

### Changed

- DorkOS now turns down a handle that looks like someone else's, like `@d0rian` or `@dor1an` next to `@dorian`, or `@writer_ops` next to `@writer-ops`, and `@room` joins the reserved words.
