---
covers:
  - 'feat(tasks): the schedule form shows its autonomy level and confirms Full (DOR-3841)'
---

### Changed

- The New schedule and Edit schedule forms now show how much the agent may do on each run, right on the form instead of under Advanced settings, with a line that says what that level allows (DOR-3841)
- Saving a schedule at Full autonomy, or at another level that never stops to ask, now asks you to confirm once. Cancel saves nothing. Lower levels save straight away, and re-saving a schedule that was already at Full doesn't ask again (DOR-3841)
