---
covers:
  - "fix(rooms): say something when an agent cannot take a turn (DOR-621)"
---

### Fixed

- Rooms now say something when an agent cannot answer. If the agent was busy with another task, or its turn hit an error, the room posts a short line telling you so, instead of leaving your message sitting there with no reply. A busy agent used to just say nothing, which looked exactly like a broken one. (DOR-621)
- A slow answer is no longer thrown away or cut off. If an agent takes longer than ten minutes, the room stops waiting but the agent keeps working, and its full answer is posted when it lands, with a note saying which message it answers. Before this, the room either went quiet or posted whatever half-sentence the agent had written so far as if it were the finished answer. (DOR-621)
