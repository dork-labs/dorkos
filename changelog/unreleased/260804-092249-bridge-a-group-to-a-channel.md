---
covers:
  - 'feat(server): persist the raw platform chat type on a binding so a group bridges and a broadcast is refused precisely (DOR-907)'
  - 'fix(client,server): a known group can now be bridged to a channel; a broadcast says so plainly (DOR-907)'
---

### Added

- You can now set up a group chat to become a channel, not just a one-to-one. In a messaging connection's settings, the Bridge to a channel action now works for a group: turning it on creates a channel where the group's messages are set up to land in a shared log your agent reads, and the agent stays quiet until it's mentioned. A broadcast channel still can't be bridged, and now says exactly that ("a broadcast channel, not a two-way conversation") instead of the old catch-all reason. A chat connected before this change carries no record of what kind it is, so it stays a one-to-one-only bridge until a new message comes through. (DOR-907)
