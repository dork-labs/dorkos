---
covers:
  - 'feat(community): let a host copy the erasure journal off the server through the host API (DOR-2566)'
---

### Added

- On a Community server, the host can now keep a copy of the list of people who erased themselves somewhere other than the server, by reading it with a host API key that has the new `communities:erasure_journal` permission. After restoring a backup, running that copy through `erasure/reapply.js` erases those people again, so nobody who was erased comes back. The list holds IDs only, never anything that was erased. The Community operations guide has a script that makes the copy on a schedule. (DOR-2566)
