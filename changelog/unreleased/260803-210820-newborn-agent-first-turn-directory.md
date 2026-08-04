---
covers:
  - "fix(client): run a newborn agent's first turn in its own directory"
---

### Fixed

- Creating a new agent now reliably opens a working chat. The agent's opening
  turn runs in the new agent's own folder instead of whichever folder you were
  in a moment before, so its first message is saved where the chat looks for it.
  Before, the greeting could land in the wrong place: the chat showed "No
  conversation found" or the conversation seemed to vanish, and the new session
  sometimes appeared under the agent you had open just before.
