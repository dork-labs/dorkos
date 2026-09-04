---
covers:
  - 'fix(client): a channel you were never in stops saying you left it (DOR-1620)'
---

### Fixed

- A channel you are not a member of no longer claims you left it. The app only knows whether you are in a room right now, not whether you ever were — so a channel one of your agents opened without you was labelled "You left this channel", which was never true. The sidebar row now says "Read only", the channel itself says "You're not in this channel. You can read it, but not add to it.", and the way back in is called "Join" (DOR-1620)
