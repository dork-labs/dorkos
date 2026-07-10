### Fixed

- Scheduled task history now shows the truth: finished runs stay finished, even after a restart. Runs used to get stuck showing "running" forever even though they'd actually succeeded, and a server restart could rewrite that entire successful history to "failed" (DOR-248, DOR-249)
- Creating a scheduled task now shows its next run time right away, instead of only after refreshing the task list
