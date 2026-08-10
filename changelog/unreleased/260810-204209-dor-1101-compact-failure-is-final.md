---
covers:
  - 'fix(server,client): a /compact that reports failure never runs afterwards (DOR-1101)'
---

### Fixed

- **When `/compact` says it failed, it really did not run.** If you typed `/compact`
  while your agent was still working, it waited its turn behind the reply in
  progress. After 30 seconds DorkOS gave up on the request and showed you an error —
  but the compaction was still sitting in line, and it went ahead minutes later
  anyway. You would come back to a conversation that had been shortened without your
  say-so, after being told nothing had happened. Now DorkOS stops waiting first and
  tells you the chat is busy, and the compaction is dropped for good. Run `/compact`
  again once the reply is done (DOR-1101)
