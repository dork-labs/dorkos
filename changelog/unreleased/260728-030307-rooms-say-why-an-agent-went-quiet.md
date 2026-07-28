---
covers:
  - 'fix(rooms): say something when an agent cannot take a turn (DOR-621)'
  - 'test(rooms): pin the wait/ceiling clamp, which nothing could have caught'
  - "fix(rooms): bound each turn's collector, and damp the notice on a key that repeats (DOR-621)"
  - 'chore(changelog): fold the generated fragment into the written one'
---

### Fixed

- Rooms now say something when an agent cannot answer. If the agent was busy with another task, or its turn hit an error, the room posts a short line telling you so, instead of leaving your message sitting there with no reply. A busy agent used to just say nothing, which looked exactly like a broken one. You get one line, not one per message you sent. (DOR-621)
- A slow answer is no longer thrown away or cut off. If an agent takes longer than the room's wait, the room stops waiting but the agent keeps working, and its full answer is posted when it lands, quoting the message it answers and saying how long it took. Before this, the room either went quiet or posted whatever half-sentence the agent had written so far as if it were the finished answer. (DOR-621)
- Sending a second message to an agent that is still working no longer posts a stray fragment of its first answer. (DOR-621)

### Added

- Two new settings for rooms: `rooms.replyWaitMinutes` (how long a room waits for an answer, 10 minutes by default) and `rooms.lateReplyCeilingMinutes` (when it gives up and says the agent could not finish, 60 minutes by default). (DOR-621)
