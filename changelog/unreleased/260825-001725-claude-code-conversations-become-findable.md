---
covers:
  - 'feat(server): your Claude Code conversations become findable (DOR-681)'
---

### Added

- DorkOS now keeps a searchable copy of what was said in your Claude Code chats — including the ones you ran from the plain `claude` command line, outside DorkOS. It reads the chat files Claude Code already writes and never changes them. Nothing in the app searches this yet; the search box itself comes next (DOR-681)
- It only keeps what was **said**: your messages and the agent's replies, in plain words. Command output, file contents, and the agent's private notes are left out on purpose, so the copy stays small and a search does not fill up with machine noise (DOR-681)
- A few kinds of chat are left out for the same reason. Conversations a helper agent had with itself are not yours, so they are skipped. So are the throwaway chats our own test runs produce (DOR-681)
- The copy stays up to date without re-reading everything. DorkOS remembers how far into each chat file it got and picks up from there, and it notices a chat that was half-written when it looked — so a message that was still being saved is read whole the next time round, never cut in half (DOR-681)
