---
covers:
  - "fix(session): widen the session-list wire's permission-mode id to match what a runtime actually reports (DOR-851)"
  - 'fix(sessions): address adversarial review on the permission-mode read-side fix (DOR-851)'
---

### Fixed

- Fixed the sidebar session list going empty for a runtime whose permission-mode names sit outside DorkOS's shared list — new sessions and status updates for it were silently dropped instead of shown (DOR-851)
