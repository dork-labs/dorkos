---
covers:
  - "fix(session): bound the stall watchdog's interrupt and log every stall"
  - 'fix(session): keep a turn waiting on a person alive, and end orphaned streams'
  - "fix(runtime): match the SDK's project-slug exactly, and log approvals at info"
  - 'fix(session): bound the pause probe by the interaction timeout'
---

### Fixed

- An agent that stops to ask your permission no longer gets cut off as stuck. If a second reply started on the same chat while the first was still waiting on your answer, DorkOS could decide the waiting agent had frozen and end its turn ten minutes later. The turn now stays open while it waits on you. (The permission request itself still expires after 10 minutes, as before.)
- Long jobs keep their chat to themselves. A turn that ran longer than five minutes — normal for room agents and for anything that reads a lot of files — used to become fair game for another browser tab or device, which could start a second reply on top of it. A turn that is still working, or still waiting on you, now holds the chat for as long as it needs. One that has genuinely gone quiet is still handed back after five minutes.
- Sessions started in a linked folder, a folder with accented characters in its name, or a very deeply nested one now find their earlier history instead of starting from scratch.
- When the same chat opened twice at once, one of the two views could go permanently silent — connected, but never receiving anything again. It now reconnects and catches up.
- If DorkOS can't stop a frozen agent, it no longer waits forever trying. It gives up after 30 seconds, closes the turn, and says what happened in the log.
