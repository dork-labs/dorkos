---
covers:
  - 'feat(rooms): a channel is born with its agents in it (DOR-599, DOR-600)'
  - 'fix(rooms): tell the three roster states apart, and stop Enter adding what the cursor rests on'
  - 'fix(rooms): make the announced row the row Enter acts on, and let the slice own its fleet'
---

### Added

- You can now pick the agents when you make a channel. The **+** next to "Channels" opens a dialog that asks for a name and who's in it, instead of just a name. A channel with nobody in it has nobody to answer you, so this is now one step rather than a thing you couldn't do at all. If you really want an empty one, "Create it without agents" is still there (DOR-599)
- You can add agents to a channel any time afterwards, from three places: the row of faces at the top of an open channel, the "Add agents" button in a channel with nothing in it yet, or a right-click on the channel in the sidebar. All three open the same panel, which is also where you remove someone and set how each agent decides when to reply in that channel (DOR-600)
