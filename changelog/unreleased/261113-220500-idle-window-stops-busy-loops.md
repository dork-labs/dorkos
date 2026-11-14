---
covers:
  - 'fix(client): an idle window stops redrawing work nobody can see (DOR-3312)'
  - 'fix(client): a hidden tab shows a still working icon while a turn runs (DOR-3312)'
---

### Fixed

- Keep the app quiet when nothing changes: a shared browser page no longer re-measures itself every frame, and the busy tab icon stops animating where nobody can see it. (DOR-3312)
