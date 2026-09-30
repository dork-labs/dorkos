---
covers:
  - 'feat(community): let a host copy the erasure journal off the server through the host API (DOR-2566)'
  - 'fix(community): give the erasure journal its own lock, and keep its lines only as long as a backup can need them (DOR-2566 review)'
  - 'fix(community): tighten the advisory-lock guard and note journal duplicates and the retention ceiling (DOR-2566 review)'
---

### Added

- On a Community server, the host can now keep a copy of the erasure journal, the list of people who erased themselves, somewhere other than the server, by reading it with a host API key that has the new `communities:erasure_journal` permission. After restoring a backup, running that copy through `erasure/reapply.js` erases those people again, so nobody who was erased comes back. The list holds IDs only, never anything that was erased. The server keeps journal lines for `COMMUNITY_ERASURE_JOURNAL_RETENTION_DAYS` (400 days unless you change it) and deletes them after that. The Community operations guide has a script that makes the copy on a schedule. (DOR-2566)
