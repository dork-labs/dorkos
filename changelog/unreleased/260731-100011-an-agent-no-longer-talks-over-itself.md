---
covers:
  - 'fix(rooms): an agent no longer answers twice at once in one room'
---

### Fixed

- **An agent no longer talks over itself.** Send a channel a second message while an agent is still working on your first one, and it used to quietly start a second answer alongside the first — two answers being written at once, on the same thread of memory, costing you twice as much. Now the room finishes one before it starts another, and says so: "Ana is still working on an earlier message here. It didn't pick this one up — that answer will land in this conversation."

This was easiest to hit with a slow agent, because a channel keeps an agent answerable for about ten minutes after you draw it in — so every message you sent while you waited was another answer starting behind the one you were waiting for. The room answers every message you addressed to that agent, and stays quiet about the ones you did not — and if the turn you were waiting for then falls over, you are told that too, rather than being left waiting on the busy line.
