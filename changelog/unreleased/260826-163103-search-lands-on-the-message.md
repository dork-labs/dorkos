---
covers:
  - 'feat(db,shared): the message index carries the id a hit can land on (DOR-1579)'
  - 'feat(server): every projection carries the message id its store gave it (DOR-1579)'
  - 'feat(client): a conversation hit opens on the message it matched (DOR-1579)'
---

### Improved

- Search results from your Claude Code and OpenCode sessions now jump to the exact message, the way channel results already do. The message is centred on screen, with what was said around it still visible. If DorkOS can't place a result — an older link, or a conversation that has since been rewritten — it opens the conversation as before (DOR-1579)
