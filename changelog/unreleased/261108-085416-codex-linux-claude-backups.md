---
covers:
  - 'fix(codex): start on Linux when Claude Code sign-in backups exist, and say when the sandbox is the problem (DOR-3949, DOR-3950)'
  - 'fix(codex): skip hidden folders whichever folder rg runs from (DOR-3949)'
---

### Fixed

- Codex chats start again on Linux computers that also use Claude Code. Claude Code's saved sign-in copies stay hidden from Codex (DOR-3949).
- When Codex's sandbox can't start on Linux, DorkOS now says so and points to the setup guide. It no longer tells you to send your message again (DOR-3950).
