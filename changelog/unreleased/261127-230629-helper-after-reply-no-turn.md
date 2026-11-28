---
covers:
  - 'fix(runtimes): a helper still working after the reply no longer starts a turn of its own (DOR-2698)'
  - "fix(runtimes): a helper's ask after the reply reaches the chat without holding it (DOR-2698)"
  - "fix(runtimes): a helper's wait in line no longer holds the chat, and its approval turn costs nothing (DOR-2698)"
---

### Fixed

- When a Claude Code agent's helper keeps working after the agent replies, the chat no longer shows the agent as busy the whole time, and your next message no longer waits behind it. If the helper asks for your approval, the card still shows up in the chat, and a message you send waits until you answer it, as it does for any card. The helper's report still arrives when it finishes (DOR-2698)
