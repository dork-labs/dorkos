---
covers:
  - 'fix(codex): start on Linux when Claude Code sign-in backups exist, and say when the sandbox is the problem (DOR-3949, DOR-3950)'
  - 'fix(codex): skip hidden folders whichever folder rg runs from (DOR-3949)'
  - "fix(codex): keep every mask when a hidden folder's path is copied elsewhere (DOR-3949)"
---

### Fixed

- Codex chats start again at Ask and Edit on Linux computers that also use Claude Code. Claude Code's saved sign-in copies stay hidden from Codex (DOR-3949).
- When Codex's sandbox can't start on Linux, DorkOS now says so and points to the setup guide. It no longer tells you to send your message again (DOR-3950).

### Note for people upgrading

- On Linux, Codex at Full autonomy doesn't start if Claude Code has run on the same machine, and that includes the Docker image. Use Ask or Edit there for now. We're fixing it (DOR-3965).
