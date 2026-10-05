---
covers:
  - 'fix(sessions): later agent turns reach the relay caller and the task run that asked (DOR-2717)'
  - 'fix(sessions): end every late-turn follow on new work, and never leave a caller waiting (DOR-2717)'
---

### Fixed

- When an agent hands work to a helper and reports back later, that report now reaches whoever asked. An agent that sent the work with a message it checks back on gets the late answer in the same inbox for up to 30 minutes, or a note that none is coming. An agent that waited for a single reply is told the other agent is still working, since that later answer cannot reach it. A scheduled task's run history shows what the agent reported after the run ended.
