---
covers:
  - "perf(server): tidy deleted chats' canvases without listing every chat (DOR-2905)"
---

### Fixed

- DorkOS no longer reads through your chats every five minutes for nothing. A background check listed all of them to clean up the canvas of deleted chats, even when no chat had been deleted. Now it only looks when there is something to clean up (DOR-2905)
