---
covers:
  - 'feat(client): one attention engine — a proposed schedule asks you on the Home screen, and idle rows stop nagging (DOR-1381)'
  - 'fix(client): the review pass on the one attention engine — answers stay in place, all-clear waits for every source (DOR-1381)'
---

### Added

- When an agent proposes a scheduled task, it now shows up under **Needs Attention** with **Approve**
  and **Reject** buttons, on the Home screen and in the top-right indicator. Before this, the only
  way to find one was to wander into the Tasks page (DOR-1381)

### Changed

- Home's **Needs Attention** now shows only what is actually stopped and waiting on you: a proposed
  schedule, or a session that hit an error. What merely went wrong lately (a failed run,
  undeliverable messages, an agent nobody can reach) moved to its own quieter **Recent Activity**
  group. An agent waiting on your answer is now drawn once, as a card, instead of twice (DOR-1381)
- "Session idle for 47 minutes" rows are gone from the Home screen. A session going quiet was never
  something you had to answer, and saying so every minute for a day taught people to skip the whole
  group (DOR-1381)
