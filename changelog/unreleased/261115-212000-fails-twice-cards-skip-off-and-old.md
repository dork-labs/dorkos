---
covers:
  - 'fix(tasks): fails-twice cards skip schedules that are off and failures from before the last change (DOR-4127)'
  - "fix(tasks): the fails-twice room line counts like the card, after the schedule's last change (DOR-4127)"
---

### Fixed

- **Needs you** no longer shows a "failed twice in a row" card for a schedule that is turned off, and turning a schedule off clears its card. A card also needs two failures since the schedule was last turned on or edited, so failures from weeks ago no longer turn up there. The line in the schedule’s room follows the same rule. The Schedules list still shows those schedules as failing.
