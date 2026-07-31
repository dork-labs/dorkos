---
covers:
  - 'fix(rooms): an agent no longer answers twice at once in one room'
---

### Fixed

- **An agent no longer talks over itself.** Send a channel a second message while an agent is still working on your first one, and it used to quietly start a second answer alongside the first — two answers being written at once, on the same thread of memory, costing you twice as much. Now the room finishes one before it starts another, and says so: "Ana was busy with something else and did not pick this up. Send it again when Ana is free."

This was easiest to hit with a slow agent, because a channel keeps an agent answerable for about ten minutes after you draw it in — so every message you sent while you waited was another answer starting behind the one you were waiting for. The room says the busy line once, until that agent answers you again — and if the turn you were waiting for then falls over, you are told that too, rather than being left waiting on the busy line.
