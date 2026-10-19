---
covers:
  - "feat(server): a Wi-Fi sign-in's mark follows its work everywhere, held to Default and Allow once (DOR-3061)"
---

### Changed

- Words sent from a Wi-Fi sign-in now carry a mark to everything they cause. That includes a message an agent sends on, a chat it starts, a room post, a schedule, a promise, a heartbeat, and a turn that picks the chat up again by itself. Every such turn runs at the agent's Default level at most, so each file or shell step asks first.
- An approval card raised by that work offers only Allow once or Deny, never Always allow. A schedule it writes waits for you and says it came from a Wi-Fi sign-in.
- A turn that picks a chat up by itself now carries what the chat's latest turn carried. This covers an approval's answer, an automatic resume or handoff, a nudge after a sign-in, and a wake after a restart. It applies to teammates' messages in a shared space too.
