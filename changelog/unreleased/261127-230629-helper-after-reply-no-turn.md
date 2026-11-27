---
covers:
  - 'fix(runtimes): a helper still working after the reply no longer starts a turn of its own (DOR-2698)'
---

### Fixed

- When a Claude Code agent's helper keeps working after the agent replies, the chat no longer shows the agent as busy the whole time, and your next message is no longer held behind it. The helper's report still shows up in the chat when it finishes (DOR-2698)
