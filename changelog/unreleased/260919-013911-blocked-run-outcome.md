---
covers:
  - 'fix(tasks): a scheduled run refused every tool is recorded as blocked, not a success (DOR-2101)'
---

### Fixed

- A scheduled task that could not use a single one of its tools is now marked **Blocked**, instead of getting a green tick. A task on a timer runs while you are elsewhere, so there is nobody to approve a tool it asks about — and DorkOS turns those requests down on the spot. When every one of them is turned down, the task runs, takes a few seconds, does nothing at all, and used to be filed as a success: one mailbox task read no mail twice in an afternoon and left two green rows behind it. Blocked is its own outcome in the run history, with the tools it was denied named on the row, its own entry in your activity feed, and its own notification — because a task that quietly does nothing every night is the one thing you cannot spot for yourself. It also dims the health light at the top of the window, the same as a failure does. Nothing broke, so there is nothing to debug; what it needs is permission. A task that lost one tool and got on with the rest of its work still counts as completed, and so does one that simply ended by asking you a question (DOR-2101)
