---
covers:
  - 'fix(cloud): bind identity and delayed responses to the current link'
  - 'fix(cloud): recheck credits after launch preparation'
---

### Fixed

- Make unlinking from DorkOS Cloud take effect locally at once. Delayed responses can no longer restore an old link or remove a newer one.
- Use the identity confirmed by DorkOS Cloud when preparing credits for an agent. Credits stay unavailable if the service cannot confirm this installation, and unlinking or replacing its sign-in makes previously prepared credits unusable.
