---
covers:
  - 'feat(client): fold power-user Settings into one Advanced group'
  - 'fix(client): give the Advanced fold its own tab list, and reach every Settings tab from the palette'
  - 'docs(site): recapture the DorkOS account shots with the new Settings grouping'
  - 'fix(client): keep the plain Settings row first in the palette, and name each tab row after its tab'
---

### Changed

- Settings is shorter. You see the tabs you use day to day, in three groups: You, Agents, and This computer. Server, Tools, Room limits, Experiments and Danger zone now sit under **Advanced** at the bottom, folded until you open it. Settings remembers whether you left it open, and a link to any of those tabs opens it for you. Each built-in Settings tab is also in the command palette now, so typing "danger" or "room limits" takes you straight there. Room limits holds the defaults every room follows; a room can still set its own limits in its own panel. (DOR-2629)
