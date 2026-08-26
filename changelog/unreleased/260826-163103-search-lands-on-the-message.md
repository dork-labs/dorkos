---
covers:
  - 'feat(db,shared): the message index carries the id a hit can land on (DOR-1579)'
  - 'feat(server): every projection carries the message id its store gave it (DOR-1579)'
  - 'feat(client): a conversation hit opens on the message it matched (DOR-1579)'
---

### Added

- Search results from your Claude Code and OpenCode chats now open on the exact message you searched for, the way channel results already do. The message sits in the middle of the screen, so you can read what was said around it. When DorkOS can't find the message, from an old link or a chat that has changed since, it opens the chat as before (DOR-1579)
