---
covers:
  - 'fix(claude-code): measure the four-hour background ceiling in awake time'
  - 'fix(claude-code): measure the approval wait and the non-warm helper ceiling in awake time too'
---

### Fixed

- Waking a laptop that slept for hours no longer closes agents that were still waiting on background work. The four-hour limit, and the wait for an answer to an approval, now count only time the computer was awake.
