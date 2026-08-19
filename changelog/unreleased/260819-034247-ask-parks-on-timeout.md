---
covers:
  - 'feat(server,shared): a prompt past its budget parks instead of vanishing (DOR-1350)'
  - 'feat(server): the runtimes hold an unanswered prompt instead of refusing it at ten minutes (DOR-1350)'
  - 'feat(server,shared): a session waiting on a person is not idle, and a scheduled run never waits (DOR-1350)'
  - 'feat(client,server): a parked Ask says the agent is waiting, and still takes an answer (DOR-1350)'
  - "refactor(server): one prompt's wait lives in its own module (DOR-1350)"
  - 'fix(client): a card that parks while somebody is watching reads like one that arrived parked (DOR-1350)'
---

### Changed

- Your agent now waits for you instead of guessing for you. When an agent asks to run something and nobody answers, the ten-minute countdown still runs exactly as it did. What changes is what happens next: the card says "waiting for you", the agent holds the question, and answering it hours later picks up right where you left off. Go to lunch, sit through a meeting, do the school run. Four hours on, the agent does give up, and it tells you how long it waited (DOR-1350)
- A scheduled task is the one exception. Nobody is watching a scheduled run, so its questions are still refused after ten minutes and the run carries on (DOR-1350)
