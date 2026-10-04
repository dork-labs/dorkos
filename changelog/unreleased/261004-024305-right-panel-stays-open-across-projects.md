---
covers:
  - 'fix(client): keep the right panel open when you switch to another project (DOR-2579)'
---

### Fixed

- The right panel now stays open, on the same tab, when you switch to a chat in another project. Before, it closed, so a tab like Flow had to be reopened after every switch. A project where you left the panel a certain way still opens it that way. If the new project doesn't have the tab you had open, the panel switches to another tab instead of closing. Because the old behavior saved "closed" for every project it visited, the panel forgets those saved layouts once (DOR-2579)
