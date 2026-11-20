---
covers:
  - 'fix(extensions): keep healthy apps running through host stalls (DOR-4785)'
---

### Fixed

- A busy DorkOS no longer stops a healthy mini app by mistake. If an app stops, a notice names it and says DorkOS is restarting it. If it stops too often, the notice offers Restart (DOR-4785)
