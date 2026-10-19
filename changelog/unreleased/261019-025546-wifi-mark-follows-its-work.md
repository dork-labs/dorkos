---
covers:
  - "feat(server): a Wi-Fi sign-in's mark follows its work everywhere, held to Default and Allow once (DOR-3061)"
  - 'chore(server): the Wi-Fi mark survives renames, compactions and failed writes, and only a person clears it (DOR-3061)'
---

### Changed

- Words sent from a Wi-Fi sign-in now carry a mark to everything they cause. That includes a message an agent sends on, a chat it starts, a room post, a schedule, a promise, a heartbeat, and a turn that picks the chat up again by itself. Every such turn runs at the agent program's starting level at most, the one that asks before each file or shell step, whatever level you set for the agent.
- An approval card raised by that work offers only Allow once or Deny, never Always allow. A schedule it writes waits for you and says it came from a Wi-Fi sign-in.
- A turn that picks a chat up by itself carries what that chat carried. This covers an approval's answer, an automatic resume or handoff, a nudge after a sign-in, a wake after a restart, and a compaction. It applies to teammates' messages in a shared space too. Only your own next message from this computer clears it.
- Chats you already had before this update keep working as they did.
