---
covers:
  - 'fix(tasks): a package-shipped schedule that ships switched off raises no card (DOR-2059)'
  - 'fix(tasks): key the DOR-2059 quiet-parking decision on origin, not enabled'
  - 'fix(tasks): tie needsScheduleApprovalAttention to a real discovered row, gate the source line size and derive it (DOR-2059 delta review)'
---

### Fixed

- Installing a package no longer asks you to approve a schedule it shipped switched off. A schedule like that now shows up on the Schedules page already off, with its source named so you can tell it came from the package — switch it on yourself and DorkOS runs it through the same approval it always has. A schedule a package ships switched on still asks first, the way it always has
