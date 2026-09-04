---
covers:
  - 'fix(harness,cli): harness sync says which plugin hooks it had to drop (DOR-1724)'
---

### Fixed

- When a plugin's `hooks/hooks.json` is damaged, DorkOS keeps the parts it can still read and skips the rest. It used to skip them silently, so a hook could stop running with nothing anywhere to say so. `dorkos harness sync` now names the file and each affected event, and says whether the rest of that event still runs (DOR-1724)
