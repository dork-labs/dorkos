---
covers:
  - 'feat(community): enforce projected connection access'
  - 'feat(community): project verified connection access'
  - 'fix(community): enforce projected access everywhere'
  - 'fix(community): refresh streams when access changes'
  - 'fix(community): reconcile revoked connection grants'
  - 'fix(community): render revoked stream state immediately'
---

### Added

- Community channels now follow what you're allowed to do there right now. If a community's server can't be reached, you can still read saved messages, but posting waits until it's back. Archived communities stay read-only. If a community removes your access, DorkOS clears its private messages until you reconnect.
