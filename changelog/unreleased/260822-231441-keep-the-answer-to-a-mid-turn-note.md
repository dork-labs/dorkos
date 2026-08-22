---
covers:
  - 'fix(server): keep the answer to a steer inside the turn it belongs to (DOR-1314)'
  - 'test(server): pin the steer continuation the pump drops (DOR-1314)'
  - 'fix(server): finish the continuation grace state machine (DOR-1314)'
---

### Fixed

- If you turn on the experimental setting that keeps an agent warm between messages (`runtimes.claudeCode.persistentSession`, off by default), the answer to a note you add mid-turn now stays in the chat. Before, when you sent something while your agent was still working, the agent often answered it in a separate turn. That answer did not reach the chat until you reloaded the page. It now arrives in the turn you are watching (DOR-1314)
