---
covers:
  - 'perf(client): a streamed word no longer lays out the whole chat again (DOR-2912)'
---

### Changed

- Replies stream more smoothly in very long chats. Each new word used to rearrange every message in the chat; now only the newest messages are rearranged, about 15 times less work in a 3,000-message chat.
