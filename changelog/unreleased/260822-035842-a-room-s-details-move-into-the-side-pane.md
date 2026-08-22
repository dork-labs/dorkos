---
covers:
  - "feat(client): a room's details move into the side panel, and the sheet is gone (DOR-1403)"
  - "test(client): the three doors, the Room tab, and an agent's face on the roster (DOR-1403)"
  - 'wip(e2e): re-point the room specs at the panel (DOR-1403)'
  - "merge: bring R1's updated branch (and main) under the room panel (DOR-1403)"
  - "feat(client): a one-to-one wears its agent's face again, in the bar and the panel (DOR-1403)"
  - 'test(e2e): the room specs meet the panel in a browser (DOR-1403)'
  - "chore(e2e): record the room specs' latest runs (DOR-1403)"
  - 'fix(client,e2e): answer the R2 review — the missing room, the home indicator, and the doors nobody had tested (DOR-1403)'
---

### Changed

- Everything about a room now opens in the side panel instead of a pop-up over it. Who is in the room, what it is about, how loud each agent is, and the way to add or remove one all sit beside the conversation, so you can read the room while you change it (DOR-1403)
- The panel has its own tab, next to Pulse. Opening a channel or Home puts you on it, and Pulse is still one press away (DOR-1403)
- The three ways in still go where they always did. The head count in the header opens the list of members, an empty room's "Add agents" opens the picker ready to type, and the sidebar menu's Members, Add agents and Edit topic each open the part they name (DOR-1403)
- Picking one of those from the sidebar now opens that room as well, so the panel is always about the room you are looking at (DOR-1403)
- On a phone the panel slides over the room, the way the pop-up used to (DOR-1403)

### Fixed

- A one-to-one shows the agent's own picture again, in the header and beside their name in the panel. For a while it showed nowhere (DOR-1403)
- Opening a link to a room that has been deleted now says so in the panel, instead of showing a name that never arrives (DOR-1403)
- Pressing the head count moves the keyboard into the list of members, so you can get there without a mouse (DOR-1403)
- On a phone, the Archive button no longer sits under the home indicator (DOR-1403)
