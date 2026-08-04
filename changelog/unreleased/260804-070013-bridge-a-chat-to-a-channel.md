---
covers:
  - 'feat(server): route binding bridge transitions through BridgeLifecycle (DOR-878)'
  - 'feat(client): Bridge to a channel action on the Connections detail sheet (DOR-878)'
  - 'fix(client,server): only bridge a one-to-one chat until a broadcast can be told apart (DOR-878)'
---

### Added

- Connections has a new Bridge to a channel action. In a messaging connection's settings, you can turn a one-to-one chat into a channel: its messages are set up to land in a shared log your agent reads, and you can post into the chat from the cockpit. The same screen turns bridging back off (after telling you what that archives), lets you choose whether the chat hears about a failed or stopped turn, and says plainly why a chat can't be bridged when it can't, instead of a greyed-out button. (DOR-878)
