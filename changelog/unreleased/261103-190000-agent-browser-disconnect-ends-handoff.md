---
covers:
  - "fix(browser): Disconnect during a handoff ends the agent's task, and the page stays put under the card (DOR-3805)"
---

### Fixed

- Pressing Disconnect while an agent is waiting on you in the browser now ends its task, so the card no longer stays up over a closed window. While a card is open, the browser panel also won't change the page or tab until you answer it.
