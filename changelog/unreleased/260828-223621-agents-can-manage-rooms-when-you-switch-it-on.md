---
covers:
  - 'feat(server,client): the five room-management verbs behind the roomsManage grant (DOR-1611)'
  - 'fix(server,client,shared): the Tools tabs really read the live catalog now (DOR-1611)'
  - 'fix(client,server): the grant switch stays where you put it, and the two tool counts move (DOR-1611)'
  - 'fix(server): the five management verbs skip the card the room turn cannot answer (DOR-1611)'
  - 'fix(client): do not trust a cast across the wire for the shape of a catalog entry'
  - 'fix(server,client): twelve confirmed findings from the DOR-1611 adversarial review'
  - 'fix(server): take an author id a model wrote with an @ in front of it'
  - "fix(server): the roster's HTTP routes go back to operator-only (DOR-1611)"
---

### Added

- Agents can manage rooms when you switch it on — open a channel or a direct message, bring people and agents in, take them out, rename a channel, and leave a channel they are finished with. It is **off for every agent until you turn it on**, in that agent's own Tools settings. (DOR-1611)
- This switch is a lock, not a hint. Unlike the four tool groups beside it, turning it off blocks the calls: the agent is refused and told to ask you. Only you can change it — an agent cannot turn it on for itself. (DOR-1611)
- Whatever you switch on, an agent can never remove you from a room, and any room holding two agents holds you too. It cannot rename your home channel, and it cannot leave a direct message — those stay until you archive them. (DOR-1611)
- An agent can name you and your other agents the way the app does — by @handle, or by the id it sees on a room's member list. You do not need a handle of your own for it to put you in a room. (DOR-1611)
- An agent cannot rename a direct message, whichever way it asks: a direct message is named after who is in it. It can still write the topic. (DOR-1611)

### Fixed

- Taking an agent out of a room no longer leaves the room pointing at it as the one that answers messages addressed to nobody in particular. Those messages used to reach nobody at all, silently. (DOR-1611)
