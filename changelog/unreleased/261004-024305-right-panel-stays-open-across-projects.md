---
covers:
  - 'fix(client): keep the right panel open when you switch to another project (DOR-2579)'
  - 'fix(client): right panel review round — reload, migration, links, phones (DOR-2579)'
  - 'fix(client): right panel second review round — carried tab, phone reload, bad stored map (DOR-2579)'
---

### Fixed

- The right panel now stays open, on the same tab, when you switch to a chat in another project. Before, it closed, so a tab like Flow had to be reopened after every switch. A project where you left the panel a certain way still opens it that way. If the new project doesn't have the tab you had open, the panel shows another tab instead of closing. Reloading the app brings back the panel the way you last saw it. On a phone or narrow window, switching projects or reloading shows the page instead of covering it with the panel. The old behavior saved "closed" for every project it visited, so those saved layouts are cleared once; layouts you left open are kept (DOR-2579)
