---
covers:
  - 'fix(connections): report disabled messaging and diagnose sign-in failures'
---

### Fixed

- Messaging now says when it is off or when its options could not be loaded. It no longer suggests choosing an unavailable option or says every kind is already in use when the list failed to load.
- Managed sign-in setup failures now leave a safe, specific diagnostic without recording service metadata or account details.
