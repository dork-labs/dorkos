---
covers:
  - 'fix(runtimes): a helper still working after the reply no longer starts a turn of its own (DOR-2698)'
  - "fix(runtimes): a helper's ask after the reply reaches the chat without holding it (DOR-2698)"
---

### Fixed

- When a Claude Code agent's helper keeps working after the agent replies, the chat no longer shows the agent as busy the whole time, and your next message is no longer held behind it. If the helper needs your approval, the card still shows up in the chat, and the helper's report still arrives when it finishes (DOR-2698)
