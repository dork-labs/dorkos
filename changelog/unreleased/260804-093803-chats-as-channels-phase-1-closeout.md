---
covers:
  - 'test(relay): close the A12.1 acceptance gap + commit the A13.1/A13.2 verification artifacts (DOR-881)'
  - 'docs(decisions): extract the seven chats-as-channels ADRs (DOR-881)'
  - 'docs(guides): bridged channels - the three §9.4 statements and the how-to (DOR-881)'
---

### Added

- You can turn a connected Telegram chat into a **channel**. Its messages are set up to land in one shared log your agent reads before it answers, you can speak into the chat from the cockpit, and everyone writing in from outside your machine is clearly marked. A new [Bridged Channels](/docs/guides/bridged-channels) guide walks through it and is honest about the trade: bridging lets people you may not know put text in front of your agent, the permission mode is the real bound, and the channel log is your audit trail. (DOR-881)

### Changed

- Rooms can now carry three new status notes for a bridged channel (a message that could not be delivered, a delivery blocked by your reply or start settings, and messages arriving faster than the channel can record them). This widens the set of note types a room may hold. The DorkOS cockpit ships in lockstep and understands them, but an older client pinned to the previous set will fail to read a room that contains one of the new notes until it is updated. This is the one part of the change that is not backward-compatible; everything else is additive. (DOR-881)
