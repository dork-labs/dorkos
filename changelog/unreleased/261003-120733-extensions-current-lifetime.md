---
covers:
  - 'fix(extensions): bind publication and effects to the current extension lifetime'
  - 'fix(extensions): retain uncertain registration cleanup'
---

### Fixed

- Fix extensions failing to reload after changing projects. Stop older extension loads from changing the app after sign-out, removal, or reload.

- Stop extensions from restarting when the app cannot confirm a failed load was cleaned up.
