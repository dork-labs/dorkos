---
covers:
  - 'fix(browser): each agent gets its own Agent browser profile, and only the person can share one (DOR-4741, DOR-4818, DOR-4703)'
---

### Changed

- Give each agent its own browser, starting signed out, in a separate Chrome window (DOR-4741).
- Share the sign-ins in your Chrome window with one named agent. In-app browser sign-ins stay yours.

### Fixed

- Keep the first sign-in’s return page when another sign-in attempt is refused (DOR-4703).
- Turn off Chrome’s browser sign-in and sync offers inside DorkOS browser profiles (DOR-4818).
