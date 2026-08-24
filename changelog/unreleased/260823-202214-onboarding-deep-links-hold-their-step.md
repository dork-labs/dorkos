---
covers:
  - 'fix(client): onboarding deep-links hold their stage on a cold load (DOR-1431)'
---

### Fixed

- Opening a setup link now lands on the right step instead of bouncing to the start. A link that points straight at a later setup step also no longer breaks the app if it names a step that no longer exists — it just opens setup at the beginning (DOR-1431)
