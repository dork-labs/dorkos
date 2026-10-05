---
covers:
  - 'fix(sessions): later agent turns reach the relay caller and the task run that asked (DOR-2717)'
---

### Fixed

- When an agent hands work to a helper and reports back later, that report now reaches whoever asked. An agent that messaged it gets the late answer in the same inbox, and a scheduled task's run history shows what the agent reported after the run ended.
