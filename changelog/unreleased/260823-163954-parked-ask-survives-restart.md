---
covers:
  - 'fix(server,docs): a question your agent asked before a restart no longer vanishes (DOR-1439)'
  - 'fix(server,specs): keep an approval you already granted from being marked unanswered (DOR-1439)'
---

### Fixed

- When DorkOS restarts while an agent is waiting on you, the question it asked is now saved as
  unanswered instead of disappearing. Reopen the conversation and you can see it was asked, and
  that nobody got to answer. That agent's work stopped with the restart, so ask again to pick it
  back up (DOR-1439)
