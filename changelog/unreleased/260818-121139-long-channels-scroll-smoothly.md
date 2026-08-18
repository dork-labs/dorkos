---
covers:
  - 'refactor(client): P4.1 — one scroll hook for every conversation, and the two pieces that move with it (DOR-1331)'
  - 'feat(client): P4.2 — Conversation.Timeline, the one virtualized list, and the pending row that moves into it (DOR-1331)'
  - 'refactor(client): P4.3 — both surfaces mount the one timeline, and the two lists are gone (DOR-1331)'
  - 'feat(client): P4.4 — the two ConversationTarget adapters, one with a queue and one without (DOR-1331)'
  - 'feat(client): P4.5 — one composer card for both surfaces, and both old hosts deleted (DOR-1331)'
  - 'refactor(client): P4.6 — AssistantMessageContent split by part kind, under the 500-line bar (DOR-1331)'
  - 'test(client): P4.7 — the timeline and the composer card, and knip clean of everything this phase touched (DOR-1331)'
  - "test(e2e): P4.7 — the room's suites read a virtualized list, and the timeline moves one box rather than every row (DOR-1331)"
  - 'fix(client): P4.9 — a room comes back from a thread on the message you were reading, and the session lane says stalled and queued (DOR-1331)'
  - 'fix(client,e2e): a message taller than the window keeps its action rail, at any scroll offset (DOR-1331)'
  - 'fix(client): Enter still sends in a channel while a file is going up, and Escape leaves it alone (DOR-1331)'
  - "perf(client): the conversation's target holds still, so a streamed token no longer re-renders every message (DOR-1331)"
  - "refactor(client): a conversation's capability table declares only what something reads (DOR-1331)"
  - 'fix(client): the line above the message box says each thing once, and only where it can be read (DOR-1331)'
  - 'refactor(client): the timeline is one list again, with its four decisions in four files (DOR-1331)'
  - 'fix(client,e2e,docs): the small honest ones the two reviews found (DOR-1331)'
---

### Changed

- Long channels scroll smoothly. A channel now draws only the messages you can see, the way a session's chat already did, so a room with months of history stays as quick to scroll as a room with ten messages (DOR-1331)
- When a message arrives while you are reading back through a channel, you get a "New messages" button instead of being taken to the bottom. Press it when you are ready (DOR-1331)
- Open a thread on your phone and come back, and the channel is on the same message you were reading (DOR-1331)
- Hover a message longer than the window and its buttons stay where you can reach them, at any point in the message (DOR-1331)
