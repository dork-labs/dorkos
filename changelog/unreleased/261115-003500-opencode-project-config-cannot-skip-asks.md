---
covers:
  - '#3759'
  - 'fix(opencode): a project’s opencode.json can no longer switch off DorkOS’s asks for shell commands, edits and fetches (DOR-4394)'
---

### Fixed

- An OpenCode project you clone can no longer turn off the check DorkOS makes before an agent runs a shell command, edits a file or fetches a page. Its settings file used to be able to. An agent the project defines that would skip that check can't be started as a helper.
