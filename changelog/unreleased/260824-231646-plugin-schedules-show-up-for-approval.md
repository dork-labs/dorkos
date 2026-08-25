---
covers:
  - "fix(harness): a plugin's schedule reaches the watched skills root (DOR-1518)"
  - 'fix(cli,harness): the sync report says why a scheduled link exists (DOR-1518)'
---

### Fixed

- A plugin you install into a project can now offer you its scheduled tasks, whichever coding agents that project uses. Before this, a plugin that shipped a scheduled task was only set up for Claude Code on a normal project, and DorkOS does not look for schedules there — so the job sat on your machine and was never offered to you. Now a project plugin's scheduled tasks are put where DorkOS looks, and it asks whether you want each one to run. Plugins installed for your whole machine, rather than into one project, still cannot offer schedules this way (DOR-1518)
- `dorkos harness sync` now explains the set-up steps that need explaining. A line used to say only what was linked and where, which reads as arbitrary when the folder belongs to a coding agent you do not use. Each such line now says why it is there (DOR-1518)
