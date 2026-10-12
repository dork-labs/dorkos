---
covers:
  - 'fix(extensions): stopping or reloading an extension stops every timer it started (DOR-2462)'
---

### Fixed

- Turning off or reloading an extension now stops every repeating task it started, including ones it started after it finished loading. Before, those kept running, so after a reload the old copy's tasks could run beside the new one's.
