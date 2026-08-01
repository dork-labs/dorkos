---
covers:
  - 'fix(tasks): a scheduled run stops when you stop it, even parked on an approval'
  - 'fix(tasks): a relay-dispatched run stops when it runs past its time limit'
---

### Fixed

- A scheduled task that runs past its time limit now actually stops, even when it is sitting on a permission prompt waiting for an answer. Before, the limit only took effect the next time the agent said something — so a task parked on a prompt nobody answered kept running, held onto one of your run slots, and made shutting DorkOS down slow. This works whichever way your tasks are dispatched.
- A task run that was stopped now records why — you cancelled it, or it ran out of time — instead of reporting both the same way. Cancelling a run also shows up once in your activity feed instead of twice.
