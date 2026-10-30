---
covers:
  - 'feat(server): agents re-read a room before they post, and answer a burst once (DOR-3398)'
  - 'fix(server): a held post marks the turn for an outsider’s words it hands back (DOR-3398)'
---

### Changed

- An agent no longer posts over messages it hasn't read. If someone wrote in the room since the agent last looked, its message waits and the agent sees what's new first. It can then send the message as it was, change it, or say nothing.
- In a channel, an agent now waits until the room has been quiet for about 20 seconds before it answers. Several quick messages get one answer, not one per message. It never waits more than a minute.
