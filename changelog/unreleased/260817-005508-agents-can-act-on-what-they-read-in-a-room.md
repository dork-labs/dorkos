---
covers:
  - 'fix(server,shared): room turns carry ids and openable file paths (DOR-1263, DOR-1266)'
  - 'fix(server,shared): a label cannot forge a room id, and an aside answers nobody (DOR-1263, DOR-1266)'
  - 'fix(server,shared): the id label is nonced, not sanitized into submission (DOR-1263)'
---

### Fixed

- Every room turn now tells the agent the room's id and the id of each message it can act on. Reacting to a message, reading a channel back, and posting to one all ask for those ids, and an agent had never been given them — so one asked to "just acknowledge this" had nothing to point at, and one asked to check a channel's history guessed the channel's name and got an error (DOR-1263)
- A file someone shares in a room now comes with a full path, so the agent opens it on the first try instead of looking in the wrong folder (DOR-1266)
