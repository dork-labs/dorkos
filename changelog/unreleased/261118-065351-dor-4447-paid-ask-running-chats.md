---
covers:
  - 'fix(agents): paid actions that ask say why, and running_chats explains blank titles (DOR-4447)'
---

### Fixed

- When an agent's paid action waits for your yes, the agent is now told it costs money and why it asked: no monthly limit set, no price set for that app, or spending that can't be read right now. When cost is the only reason it asked, the agent is also told you can set a monthly limit and a price per run in Connections (DOR-4447)
- When an agent lists running chats and some titles come back blank, it is now told why: the chat has no title yet or it can't be read, or the run is set to Never ask, which hides every title (DOR-4447)
