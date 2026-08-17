---
covers:
  - 'fix(server,shared): room turns carry ids and openable file paths (DOR-1263, DOR-1266)'
---

### Fixed

- Agents can now react to a message, read a channel back, or post to it without guessing. Every room turn now tells the agent the room's id and the id of each message it can see, which is what those actions ask for — before, an agent asked to "just acknowledge this" had nothing to point at, so it posted the word "Ack" instead, and one that tried to read a channel's history guessed the channel name and got an error (DOR-1263)
- A file someone shares in a room now comes with a full path, so the agent opens it on the first try instead of looking in the wrong folder (DOR-1266)
