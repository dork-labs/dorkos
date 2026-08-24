---
covers:
  - "fix(harness): a plugin's schedule reaches the watched skills root (DOR-1518)"
---

### Fixed

- A plugin's scheduled tasks now show up for approval no matter which coding agents you use. Before this, a plugin that shipped a scheduled task only got set up for Claude Code on a normal project, and DorkOS does not look for schedules there — so the job existed on your machine and was never offered to you. Now anything with a schedule is put where DorkOS looks, and you get asked whether to run it (DOR-1518)
