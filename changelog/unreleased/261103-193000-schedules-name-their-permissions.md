---
covers:
  - 'fix(tasks): show saved permissions when an agent creates a schedule (DOR-3839)'
  - 'fix(tasks): describe refused tools and open their schedules (DOR-3839)'
---

### Fixed

- When an agent creates a schedule, its notice names the permissions it will use and explains command limits. Open the notice to review that schedule. Commands needing approval are refused on timer runs because nobody can answer. An agent creating a task without a separate mode grant gets at most Accept edits, even when the default is Full autonomy.

- Schedules now say when a command was refused in their notices and run history. The notice opens its schedule; chat messages carry only the title.
