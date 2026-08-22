---
covers:
  - 'feat(client): sections hold anything and sit at the top; the agent list stays short (DOR-1371, DOR-906, DOR-1105)'
  - "refactor(server,shared,client): the sidebar's rename is converted once, not on every read (DOR-588)"
---

### Added

- Sidebar groups are now called **sections**, and they sit at the top of the list instead of hidden under Agents. A section can hold anything you see there — a channel, a conversation, an agent — and everybody gets to make one, however few agents they have (DOR-1371)
- The Agents list shows the agents you have used lately and the ones you pinned, then a single **All 31 agents →** row that opens your team page. An agent you have not touched in a month no longer costs a row forever, and "lately" counts the last time you looked at it, not only the last time it ran. If you have eight agents or fewer, you still see all of them (DOR-1371)
- Channels and Direct messages each remember how you want them sorted — by name, or by what happened most recently (DOR-906)

### Fixed

- A section's **Show** setting now actually filters the list. It was there, it remembered your choice, and it did nothing (DOR-1371)
- A section sorted by **Recent activity** now puts channels and conversations in the right place. They used to all fall to the bottom, whatever had just happened in them (DOR-1371)
- **Mute** is gone from a section built from rules. Choosing it flipped the label and changed nothing, because a rule-built list is rebuilt every time you look at it (DOR-1371)
- **New section…** from any row now puts the name box in one place — the top of the list — instead of somewhere below your agents where a narrow sidebar could not show it (DOR-1371)
- The **N inactive** row at the bottom of Agents took a click and did nothing. It is now the "All N agents" row, which goes somewhere (DOR-1105)
- Right-clicking a channel, conversation or agent and choosing **New section…** or **Rename…** now opens the name box. It had been opening and closing again too fast to see, so the menu item looked like it did nothing — using the row's **⋮** button worked, which is why it went unnoticed (DOR-1371)

### Removed

- DorkOS no longer patches up sidebar settings written before version 0.59 on every single read, in two places. It now converts them once, the first time it looks at them, writes the result back, and never checks again. Nothing you organised is lost (DOR-588)
