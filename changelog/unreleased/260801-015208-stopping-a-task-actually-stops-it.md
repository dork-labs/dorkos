---
covers:
  - 'fix(tasks): a scheduled run stops when you stop it, even parked on an approval'
---

### Fixed

- Stopping a scheduled task now actually stops it, even when the task is sitting on a permission prompt waiting for an answer. Before, the Stop button and the task's time limit only took effect the next time the agent said something — so a task parked on a prompt nobody answered kept running, held onto one of your run slots, and made shutting DorkOS down slow. The run now ends right away, and its record says whether you stopped it or it ran out of time.
