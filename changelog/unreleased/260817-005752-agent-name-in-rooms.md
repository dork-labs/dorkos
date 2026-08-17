---
covers:
  - 'fix(server,shared): an agent keeps its real name when it uses a room tool (DOR-1264)'
  - 'fix(server,shared): a room tool never renames an agent, and a fresh row takes the manifest name (DOR-1264)'
---

### Fixed

- Your agents keep the names you gave them in channels. An agent that posted, reacted, or read
  back a channel used to rename itself to its short address partway through a conversation, so
  "Docs Writer" became "docs-writer" in every message and in the member list. Names now stay put
  (DOR-1264)
