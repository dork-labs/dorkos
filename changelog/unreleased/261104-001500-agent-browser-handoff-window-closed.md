---
covers:
  - "fix(browser): a closed window and another chat's panel both say what is really going on during a handoff (DOR-3874, DOR-3875)"
---

### Fixed

- If the agent's browser window closes while it's waiting on you, the card now says so and offers to open it again or stop the task.
- While an agent is waiting on you in the browser, the browser panel in any other chat points you to that chat, and can't resume the agent or close its window.
