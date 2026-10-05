---
covers:
  - 'fix(claude-code): measure the four-hour background ceiling in awake time'
---

### Fixed

- Waking a laptop that slept for hours no longer closes agents that were still waiting on background work. The four-hour limit now counts only time the computer was awake.
