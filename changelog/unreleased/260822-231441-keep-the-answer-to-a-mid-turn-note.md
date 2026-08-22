---
covers:
  - 'fix(server): keep the answer to a steer inside the turn it belongs to (DOR-1314)'
  - 'test(server): pin the steer continuation the pump drops (DOR-1314)'
---

### Fixed

- Keep the answer to a note you send mid-turn. When you added something while your agent was still working, the agent often answered it in a separate turn — and that answer never reached the chat until you reloaded. It now arrives in the turn you are watching (DOR-1314)
