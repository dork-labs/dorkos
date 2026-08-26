---
covers:
  - 'feat(client): click a search result and land on the message itself (DOR-687)'
---

### Improved

- Click a search result from a channel or direct message and you land on that message, not just somewhere in the conversation. It scrolls to it and marks it, so you can see straight away which line answered you — and the address in your bar points at it too, so a refresh or a link you paste to somebody lands in the same place (DOR-687)
- If the message is older than what the conversation currently has open, DorkOS says so in one quiet line instead of dropping you at the bottom and letting you wonder. Everything said there is still there (DOR-687)
- Results from your Claude Code, Codex and OpenCode chats still open the conversation rather than the exact line. The numbering search keeps for those chats counts only what was **said**, so it does not line up with everything the chat shows — and landing on the wrong line would be worse than landing in the right chat. That one is still to come (DOR-687)
