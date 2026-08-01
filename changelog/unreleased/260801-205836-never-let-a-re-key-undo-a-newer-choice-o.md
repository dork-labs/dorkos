---
covers:
  - 'fix(sessions): never let a re-key undo a newer choice, or a failed one kill the turn (DOR-493)'
---

### Fixed

- Changing how much a Claude Code session asks before acting, right as its first
  message was being sent, could be quietly undone a moment later — putting the
  agent back on the setting you had just moved away from, including "act without
  asking". Your newer choice now always wins.
- A hiccup in the settings database while a session was picking up its permanent
  name no longer ends the message you were in the middle of. It gets logged, and
  the turn carries on.
