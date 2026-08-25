---
covers:
  - 'feat(server): OpenCode conversations join the searchable copy of your history (DOR-688)'
  - "feat(server): resolve OpenCode's own data directory, as the fourth homedir carve-out (DOR-688)"
  - 'feat(server): index OpenCode conversations from a read-only snapshot of its store (DOR-688)'
  - 'fix(server): re-read OpenCode sessions while their turns are still streaming (DOR-688 review)'
---

### Added

- Your OpenCode conversations are now part of the searchable copy of your history, alongside your rooms and your Claude Code chats. Nothing in the app searches this yet — the search box itself comes next (DOR-688)
- DorkOS reads them without ever opening OpenCode's own file. Each pass takes a copy, reads the copy, and deletes it. OpenCode keeps its sign-in details in the same file as its messages, so DorkOS reads only the three tables that hold conversations and cannot reach the rest — no account or password can end up in the search index, and DorkOS never starts OpenCode in the background to read them (DOR-688)
- Anything you actually typed is kept as you typed it, including a key you happened to paste into a chat. That is your own conversation, and DorkOS treats it the way it treats every other word in it (DOR-688)
- Conversations a helper agent had with itself are left out, and so is a conversation OpenCode has deleted. If you have never used OpenCode, nothing happens and nothing is reported (DOR-688)
- A conversation you are in the middle of gets picked up properly. OpenCode writes an answer a piece at a time over as much as a minute, so DorkOS keeps re-reading anything touched in the last quarter of an hour until it settles — otherwise you could search for a sentence your agent said and never find it (DOR-688)
- If DorkOS cannot read OpenCode's file at all, searches now say so instead of quietly returning less (DOR-688)
