---
covers:
  - 'perf: a revisited chat skips the history download, and a turn fetches only its tail (DOR-2890)'
---

### Changed

- Going back to a chat you opened recently no longer downloads its whole history again; it shows what the app already has. When the agent finishes a reply, DorkOS fetches only that last exchange instead of the entire chat, so long chats stay quick turn after turn.
