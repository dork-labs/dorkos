---
covers:
  - 'feat(server): search covers every Claude Code account, not the active one (DOR-682)'
---

### Added

- The searchable copy of your Claude Code chats now covers **every** Claude Code account on your computer, not just the one DorkOS happens to be pointed at. It used to read a single account and say nothing about the rest — about half the chats on the computer where this was found, and less on a computer with more accounts. Nothing in the app searches this yet; the search box itself comes next (DOR-682)
- Which accounts get read is the same list DorkOS already uses everywhere else: the one you picked, the one your terminal points at, `~/.claude`, and any account you added in settings. Nothing is guessed — DorkOS does not go hunting for folders that merely look like accounts (DOR-682)
- If one account's folder cannot be read, DorkOS names that folder in its own log and keeps what it already knows about the account rather than throwing it away. There is nothing to see in the app; the note is for whoever goes looking in the server log (DOR-682)
