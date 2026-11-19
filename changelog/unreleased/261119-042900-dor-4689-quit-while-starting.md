---
covers:
  - 'fix(server): quitting while DorkOS is still starting no longer crashes it'
---

### Fixed

- Quitting or updating DorkOS while it was still starting up could crash it instead of closing cleanly. Now it closes cleanly at any point during startup.
