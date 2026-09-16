---
covers:
  - 'fix(community): back off blob cleanup retries'
---

### Fixed

- Cleanup after temporary storage errors now retries gradually, so one failing object does not delay other expired files and exports.
