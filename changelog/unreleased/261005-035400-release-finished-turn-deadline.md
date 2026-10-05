---
covers:
  - 'fix(server): cancel the canonical deadline after the first event'
---

### Fixed

- Release a finished agent turn's canonical-ID deadline timer as soon as its first event arrives, so it does not delay shutdown.
